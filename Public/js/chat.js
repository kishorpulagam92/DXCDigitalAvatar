// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.

// Global objects
var speechRecognizer
var avatarSynthesizer
var peerConnection
var peerConnectionDataChannel
var realtimeWebSocket = null  // Added for realtime API
var messages = []
var messageInitiated = false
var dataSources = []
var sentenceLevelPunctuations = [ '.', '?', '!', ':', ';', '。', '？', '！', '：', '；' ]
var enableDisplayTextAlignmentWithSpeech = true
var enableQuickReply = false
var quickReplies = [ 'Let me take a look.', 'Let me check.', 'One moment, please.' ]
var byodDocRegex = new RegExp(/\[doc(\d+)\]/g)
var isSpeaking = false
var isReconnecting = false
var speakingText = ""
var spokenTextQueue = []
var repeatSpeakingSentenceAfterReconnection = true
var sessionActive = false
var userClosedSession = false
var lastInteractionTime = new Date()
var lastSpeakTime
var imgUrl = ""

// Audio streaming variables
var audioContext = null
var audioProcessor = null
var isAudioStreaming = false
var audioQueue = []
var mediaStream = null // Store the media stream for audio input and muting

// Enhanced interruption detection variables
var isAvatarSpeaking = false
var userSpeechDetected = false
var vadThreshold = 0.03  // Adjusted threshold to reduce false positives
var vadBuffer = []
var vadBufferSize = 5  // Reduced buffer size for faster response
var speechStartTime = null
var minSpeechDuration = 300  // Reduced minimum speech duration (300ms)
var interruptionCooldown = 1500  // Reduced cooldown period (1.5s)
var lastInterruptionTime = 0
var interruptionInProgress = false
var speechEnergyHistory = []
var speechEnergyHistorySize = 20

// Global variables for Azure configuration
let azureConfig = {
    speechRegion: '',
    speechApiKey: '',
    openAiEndpoint: '',
    openAiApiKey: '',
    openAiDeploymentName: '',
    enablePrivateEndpoint: false,
    privateEndpoint: '',
    systemPrompt: 'You are an AI assistant that helps people find information.',
    enableOyd: false
};

// Connect to avatar service
function connectAvatar() {
    // Fetch Azure configuration from server
    fetch('/azure-config')
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to fetch Azure configuration');
            }
            return response.json();
        })
        .then(data => {
            // Store all configuration values
            azureConfig = {
                speechRegion: data.speechRegion,
                speechApiKey: data.speechApiKey,
                openAiEndpoint: data.openAiEndpoint,
                openAiApiKey: data.openAiApiKey,
                openAiDeploymentName: data.openAiDeploymentName,
                enablePrivateEndpoint: data.enablePrivateEndpoint,
                privateEndpoint: data.privateEndpoint,
                systemPrompt: data.systemPrompt,
                enableOyd: data.enableOyd
            };

            if (!azureConfig.speechApiKey) {
                alert('Azure Speech API Key is not configured. Please check server configuration.');
                return;
            }
            
            if (!azureConfig.openAiApiKey || !azureConfig.openAiEndpoint || !azureConfig.openAiDeploymentName) {
                alert('Azure OpenAI configuration is incomplete. Please check server configuration.');
                return;
            }
            
            // Continue with avatar connection using the fetched configuration
            connectAvatarWithConfig(azureConfig.speechRegion, azureConfig.speechApiKey);

            // Connect to realtime API WebSocket
            connectRealtimeAPI();
        })
        .catch(error => {
            console.error('Error fetching Azure configuration:', error);
            alert('Failed to fetch Azure configuration. Please check server logs.');
            document.getElementById('startSession').disabled = false;
            document.getElementById('configuration').hidden = false;
        });
}

// Connect to realtime API WebSocket
function connectRealtimeAPI() {
    try {
        // const realtimeEndpoint = azureConfig.realtimeEndpoint || 'ws://localhost:8765/realtime';
        const realtimeEndpoint = azureConfig.realtimeEndpoint || 'wss://digital-human-avatar-realtime-api-a3e2hcdxf6bcdga7.eastus-01.azurewebsites.net/realtime';
        console.log('Connecting to realtime API:', realtimeEndpoint);
        realtimeWebSocket = new WebSocket(realtimeEndpoint);

        realtimeWebSocket.onopen = function(event) {
            console.log('Connected to realtime API');

            // Send session configuration - optimized for direct audio input
            const sessionConfig = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'], // Keep both for transcription display
                    instructions: azureConfig.systemPrompt,
                    voice: 'alloy',
                    input_audio_format: 'pcm16',
                    output_audio_format: 'pcm16',
                    input_audio_transcription: {
                        model: 'whisper-1' // Enable transcription for UI display
                    },
                    turn_detection: {
                        type: 'server_vad', // Let API handle voice activity detection
                        threshold: 0.3,     // Lower threshold for better responsiveness
                        prefix_padding_ms: 200,
                        silence_duration_ms: 500
                    }
                }
            };

            realtimeWebSocket.send(JSON.stringify(sessionConfig));

            // Start direct audio streaming after session is configured
            setTimeout(() => {
                startDirectAudioStreaming();
            }, 1000);
        };

        realtimeWebSocket.onmessage = function(event) {
            const message = JSON.parse(event.data);
            handleRealtimeMessage(message);
        };

        realtimeWebSocket.onclose = function(event) {
            console.log('Realtime API connection closed:', event.code, event.reason);
            if (!userClosedSession && azureConfig.autoReconnectAvatar) {
                setTimeout(() => {
                    if (!userClosedSession) {
                        console.log('Attempting to reconnect to realtime API...');
                        connectRealtimeAPI();
                    }
                }, 2000);
            }
        };

        realtimeWebSocket.onerror = function(error) {
            console.error('Realtime API WebSocket error:', error);
        };

    } catch (error) {
        console.error('Error connecting to realtime API:', error);
    }
}

function connectWebSocket() {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);

    ws.onmessage = function(event) {
        const message = JSON.parse(event.data);
        
        switch (message.type) {
            case 'response.output_item.added':
                handleResponseOutputItem(message);
                break;
            case 'response.output_item.done':
                handleResponseOutputItemDone(message);
                break;
            case 'response.done':
                handleResponseDone(message);
                break;
            case 'extension.middle_tier_tool_response':
                handleToolResponse(message);
                break;
            case 'extension.interruption_acknowledged':
                handleInterruptionAcknowledged(message);
                break;
            case 'interruption':
                handleInterruption(message);
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    };

    ws.onclose = function() {
        console.log('WebSocket connection closed');
        setTimeout(connectWebSocket, 1000);
    };

    ws.onerror = function(error) {
        console.error('WebSocket error:', error);
    };

    return ws;
}

function handleInterruptionAcknowledged(message) {
    console.log('Interruption acknowledged:', message);
    
    // Stop current speech immediately
    console.log('Stopping current speech due to interruption acknowledgment...');
    stopSpeaking();
    isAvatarSpeaking = false;
    interruptionInProgress = false;
    
    // Add interruption acknowledgment to chat
    const chatHistoryTextArea = document.getElementById('chatHistory');
    if (chatHistoryTextArea) {
        chatHistoryTextArea.innerHTML += '<br/><em style="color: #ff6b6b;">[Interruption acknowledged]</em><br/>';
        chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
    }
    
    console.log('Interruption acknowledgment processed');
}

function handleInterruption(message) {
    console.log('Interruption received:', message);
    
    // Stop current speech
    console.log('Stopping current speech...');
    stopSpeaking();
    
    // Add interruption message to chat
    console.log('Adding interruption message to chat...');
    const interruptionElement = document.createElement('div');
    interruptionElement.className = 'message assistant';
    interruptionElement.innerHTML = `
        <div class="message-content">
            <div class="avatar"></div>
            <div class="message-text">${message.text}</div>
        </div>
    `;
    chatContainer.appendChild(interruptionElement);
    
    // Scroll to bottom
    console.log('Scrolling to bottom...');
    chatContainer.scrollTop = chatContainer.scrollHeight;
    
    // Speak the interruption
    console.log('Speaking interruption message...');
    speakNext(message.text);
}

// Enhanced Voice Activity Detection for interruption
function detectVoiceActivity(audioData) {
    try {
        // Calculate RMS (Root Mean Square) energy
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i] * audioData[i];
        }
        const rms = Math.sqrt(sum / audioData.length);
        
        // Add to energy history for trend analysis
        speechEnergyHistory.push(rms);
        if (speechEnergyHistory.length > speechEnergyHistorySize) {
            speechEnergyHistory.shift();
        }
        
        // Add to VAD buffer for smoothing
        vadBuffer.push(rms);
        if (vadBuffer.length > vadBufferSize) {
            vadBuffer.shift();
        }
        
        // Calculate average energy over buffer
        const avgEnergy = vadBuffer.reduce((a, b) => a + b, 0) / vadBuffer.length;
        
        // Calculate energy trend (is energy increasing?)
        let energyTrend = 0;
        if (speechEnergyHistory.length >= 2) {
            const recent = speechEnergyHistory.slice(-3).reduce((a, b) => a + b, 0) / 3;
            const older = speechEnergyHistory.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
            energyTrend = recent - older;
        }
        
        // Adaptive threshold based on recent energy levels
        const recentMax = Math.max(...speechEnergyHistory.slice(-10));
        const adaptiveThreshold = Math.max(vadThreshold, recentMax * 0.3);
        
        // Detect speech with improved logic
        const isSpeech = avgEnergy > adaptiveThreshold && energyTrend > -0.01;
        
        if (isSpeech && !userSpeechDetected) {
            // Speech started
            userSpeechDetected = true;
            speechStartTime = Date.now();
            console.log('User speech detected:', {
                energy: avgEnergy.toFixed(4),
                threshold: adaptiveThreshold.toFixed(4),
                trend: energyTrend.toFixed(4)
            });
            
            // Check if we should interrupt the avatar
            if (isAvatarSpeaking && !interruptionInProgress) {
                checkForInterruption();
            }
        } else if (!isSpeech && userSpeechDetected) {
            // Speech ended
            userSpeechDetected = false;
            speechStartTime = null;
            console.log('User speech ended:', {
                energy: avgEnergy.toFixed(4),
                threshold: adaptiveThreshold.toFixed(4)
            });
        }
        
        return isSpeech;
    } catch (error) {
        console.error('Error in voice activity detection:', error);
        return false;
    }
}

function checkForInterruption() {
    const currentTime = Date.now();
    
    // Check if interruption is already in progress
    if (interruptionInProgress) {
        console.log('Interruption already in progress');
        return;
    }
    
    // Check cooldown period
    if (currentTime - lastInterruptionTime < interruptionCooldown) {
        console.log('Interruption in cooldown period:', (currentTime - lastInterruptionTime) + 'ms <', interruptionCooldown + 'ms');
        return;
    }
    
    // Check minimum speech duration
    if (speechStartTime && (currentTime - speechStartTime) >= minSpeechDuration) {
        console.log('Triggering interruption - user has been speaking for', currentTime - speechStartTime, 'ms');
        triggerInterruption();
    } else {
        console.log('Speech duration too short:', speechStartTime ? (currentTime - speechStartTime) : 0, 'ms <', minSpeechDuration, 'ms');
    }
}

function triggerInterruption() {
    console.log('Interruption triggered!');
    
    if (interruptionInProgress) {
        console.log('Interruption already in progress, skipping');
        return;
    }
    
    interruptionInProgress = true;
    lastInterruptionTime = Date.now();
    
    // Stop avatar speaking immediately
    stopSpeaking();
    isAvatarSpeaking = false;
    
    // Send interruption signal to backend
    if (realtimeWebSocket && realtimeWebSocket.readyState === WebSocket.OPEN) {
        const interruptionMessage = {
            type: 'user.interruption',
            timestamp: Date.now()
        };
        realtimeWebSocket.send(JSON.stringify(interruptionMessage));
        console.log('Sent interruption signal to backend');
    } else {
        console.error('Cannot send interruption signal - WebSocket not connected');
        interruptionInProgress = false;
    }
    
    // Clear any pending audio responses
    audioQueue = [];
    
    // Visual feedback
    const chatHistoryTextArea = document.getElementById('chatHistory');
    if (chatHistoryTextArea) {
        chatHistoryTextArea.innerHTML += '<br/><em style="color: #ff6b6b;">[User interrupted - processing...]</em><br/>';
        chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
    }
}

// Handle messages from realtime API
function handleRealtimeMessage(message) {
    console.log('Realtime API message:', message.type);

    switch (message.type) {
        case 'session.created':
            console.log('Realtime session created');
            break;

        case 'session.updated':
            console.log('Realtime session updated');
            break;

        // Handle direct audio responses (optimized path)
        case 'response.audio.delta':
            if (message.delta) {
                playAudioDelta(message.delta);
            }
            break;

        case 'response.audio.done':
            console.log('Audio response completed');
            isAvatarSpeaking = false;
            break;

        // Handle transcription for UI display
        case 'response.audio_transcript.delta':
            if (message.delta) {
                handleRealtimeTextDelta(message.delta);
            }
            break;

        case 'response.audio_transcript.done':
            if (message.transcript) {
                handleRealtimeTextComplete(message.transcript, true); // true = from audio
            }
            isAvatarSpeaking = false;
            break;

        // Handle input transcription (user speech to text)
        case 'conversation.item.input_audio_transcription.completed':
            if (message.transcript) {
                handleUserTranscription(message.transcript);
            }
            break;

        // Legacy text responses (fallback)
        case 'response.text.delta':
            if (message.delta) {
                handleRealtimeTextDelta(message.delta);
            }
            break;

        case 'response.text.done':
            if (message.text) {
                handleRealtimeTextComplete(message.text, false); // false = from text
            }
            isAvatarSpeaking = false;
            break;

        case 'response.done':
            console.log('Response completed');
            isAvatarSpeaking = false;
            interruptionInProgress = false;  // Reset interruption state
            // Handle any remaining text
            if (currentAssistantMessage && currentAssistantMessage.trim()) {
                handleRealtimeTextComplete(currentAssistantMessage, false);
            }
            break;

        case 'response.cancelled':
            console.log('Response cancelled');
            isAvatarSpeaking = false;
            interruptionInProgress = false;  // Reset interruption state
            break;

        case 'extension.intermediate_feedback':
            if (message.feedback_text) {
                displayIntermediateFeedback(message.feedback_text);
            }
            break;

        case 'extension.interruption_acknowledged':
            handleInterruptionAcknowledged(message);
            break;

        case 'error':
            console.error('Realtime API error:', message.error);
            isAvatarSpeaking = false;
            interruptionInProgress = false;
            break;

        default:
            console.log('Unhandled message type:', message.type);
    }
}

// Handle realtime text delta (streaming)
let currentAssistantMessage = '';
function handleRealtimeTextDelta(delta) {
    currentAssistantMessage += delta;
    
    if (!isAvatarSpeaking) {
        isAvatarSpeaking = true;  // Mark avatar as speaking when text starts
        console.log('Avatar started speaking (text delta)');
    }

    const chatHistoryTextArea = document.getElementById('chatHistory');
    if (chatHistoryTextArea) {
        // Update the last assistant message
        const lastAssistantIndex = chatHistoryTextArea.innerHTML.lastIndexOf('<br/>Assistant: ');
        if (lastAssistantIndex !== -1) {
            const beforeAssistant = chatHistoryTextArea.innerHTML.substring(0, lastAssistantIndex + '<br/>Assistant: '.length);
            chatHistoryTextArea.innerHTML = beforeAssistant + currentAssistantMessage;
        } else {
            chatHistoryTextArea.innerHTML += '<br/>Assistant: ' + currentAssistantMessage;
        }
        chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
    }
}

// Handle complete realtime text response
function handleRealtimeTextComplete(text, fromAudio = false) {
    console.log('Complete text received:', text, fromAudio ? '(from audio)' : '(from text)');
    currentAssistantMessage = text;
    
    if (!isAvatarSpeaking) {
        isAvatarSpeaking = true;  // Mark avatar as speaking
        console.log('Avatar started speaking (text complete)');
    }

    const chatHistoryTextArea = document.getElementById('chatHistory');
    if (chatHistoryTextArea) {
        const lastAssistantIndex = chatHistoryTextArea.innerHTML.lastIndexOf('<br/>Assistant: ');
        if (lastAssistantIndex !== -1) {
            const beforeAssistant = chatHistoryTextArea.innerHTML.substring(0, lastAssistantIndex + '<br/>Assistant: '.length);
            chatHistoryTextArea.innerHTML = beforeAssistant + text;
        } else {
            chatHistoryTextArea.innerHTML += '<br/>Assistant: ' + text;
        }
        chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
    }

    // Always use TTS for avatar speech since direct audio playback has issues
    // The transcription gives us the exact text that was spoken by the AI
    if (avatarSynthesizer && text && text.trim()) {
        console.log('Speaking text with avatar (TTS):', text, fromAudio ? '(from audio transcription)' : '(from text)');
        speak(text.trim());
    } else {
        console.log('Avatar synthesizer not ready or no text to speak');
        isAvatarSpeaking = false;
    }

    // Add to messages array
    messages.push({
        role: 'assistant',
        content: text
    });

    // Reset current message
    currentAssistantMessage = '';
}

// Handle user speech transcription
function handleUserTranscription(transcript) {
    console.log('User speech transcribed:', transcript);

    const chatHistoryTextArea = document.getElementById('chatHistory');
    if (chatHistoryTextArea) {
        if (chatHistoryTextArea.innerHTML !== '' && !chatHistoryTextArea.innerHTML.endsWith('\n\n')) {
            chatHistoryTextArea.innerHTML += '\n\n';
        }
        chatHistoryTextArea.innerHTML += "<br/><br/>User: " + transcript + "<br/>";
        chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
    }

    // Add to messages array
    messages.push({
        role: 'user',
        content: transcript
    });
}

// Display intermediate feedback
function displayIntermediateFeedback(feedbackText) {
    console.log('Intermediate feedback:', feedbackText);

    const chatHistoryTextArea = document.getElementById('chatHistory');
    if (chatHistoryTextArea) {
        chatHistoryTextArea.innerHTML += '<br/><em style="color: #888;">' + feedbackText + '</em><br/>';
        chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;

        // Remove feedback after a few seconds
        setTimeout(() => {
            chatHistoryTextArea.innerHTML = chatHistoryTextArea.innerHTML.replace('<br/><em style="color: #888;">' + feedbackText + '</em><br/>', '');
        }, 5000);
    }
}

// Direct audio streaming functions
async function startDirectAudioStreaming() {
    if (isAudioStreaming) {
        console.log('Audio streaming already active');
        return;
    }

    try {
        console.log('Starting direct audio streaming...');

        // Clean up any existing media stream
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
        }

        // Get microphone access with optimal settings
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        audioContext = new AudioContext({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(mediaStream);

        // Create audio processor for PCM16 conversion and VAD
        audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);

        audioProcessor.onaudioprocess = function(event) {
            if (!isAudioStreaming || !realtimeWebSocket || realtimeWebSocket.readyState !== WebSocket.OPEN) {
                return;
            }

            const inputBuffer = event.inputBuffer.getChannelData(0);

            // Perform voice activity detection for interruption
            detectVoiceActivity(inputBuffer);

            // Convert float32 to PCM16
            const pcm16Buffer = new Int16Array(inputBuffer.length);
            for (let i = 0; i < inputBuffer.length; i++) {
                pcm16Buffer[i] = Math.max(-32768, Math.min(32767, inputBuffer[i] * 32768));
            }

            // Send audio data to Realtime API
            try {
                const audioMessage = {
                    type: 'input_audio_buffer.append',
                    audio: arrayBufferToBase64(pcm16Buffer.buffer)
                };
                realtimeWebSocket.send(JSON.stringify(audioMessage));
            } catch (error) {
                console.error('Error sending audio data:', error);
            }
        };

        source.connect(audioProcessor);
        audioProcessor.connect(audioContext.destination);

        isAudioStreaming = true;
        console.log('Direct audio streaming started successfully');

        // Update UI for audio streaming mode
        updateUIForAudioStreaming(true);

    } catch (error) {
        console.error('Error starting audio streaming:', error);
        alert('Could not access microphone. Please check permissions and try again.');
    }
}

function stopDirectAudioStreaming() {
    console.log('Stopping direct audio streaming...');

    isAudioStreaming = false;

    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // Reset VAD state
    userSpeechDetected = false;
    speechStartTime = null;
    vadBuffer = [];
    speechEnergyHistory = [];
    interruptionInProgress = false;

    console.log('Direct audio streaming stopped');

    // Update UI for fallback mode
    updateUIForAudioStreaming(false);
}

// Utility functions for audio processing
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// Play audio delta directly (bypassing TTS)
function playAudioDelta(audioData) {
    try {
        // Queue audio data for playback
        audioQueue.push(audioData);
        
        if (!isAvatarSpeaking) {
            isAvatarSpeaking = true;  // Mark avatar as speaking when audio starts
            console.log('Avatar started speaking (audio delta)');
        }

        // Process audio queue
        if (audioQueue.length === 1) {
            processAudioQueue();
        }
    } catch (error) {
        console.error('Error playing audio delta:', error);
    }
}

// Trigger response from realtime API (for audio streaming mode)
window.triggerRealtimeResponse = function triggerRealtimeResponse() {
    if (realtimeWebSocket && realtimeWebSocket.readyState === WebSocket.OPEN) {
        console.log('Triggering realtime API response');

        // Disable trigger button temporarily
        const triggerBtn = document.getElementById('triggerResponse');
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = 'Processing...';
        }

        // Commit the audio buffer and trigger response
        const commitMessage = {
            type: 'input_audio_buffer.commit'
        };
        realtimeWebSocket.send(JSON.stringify(commitMessage));

        // Create response
        const responseMessage = {
            type: 'response.create'
        };
        realtimeWebSocket.send(JSON.stringify(responseMessage));

        // Prepare chat history for response
        const chatHistoryTextArea = document.getElementById('chatHistory');
        if (chatHistoryTextArea) {
            chatHistoryTextArea.innerHTML += '<br/>Assistant: ';
            chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
        }

        // Mark avatar as speaking
        isAvatarSpeaking = true;

        // Re-enable trigger button after a delay
        setTimeout(() => {
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = 'Send (Space)';
            }
        }, 2000);

    } else {
        console.error('Cannot trigger response - realtime WebSocket not connected');
    }
}

// Add keyboard support
document.addEventListener('keydown', function(event) {
    // Spacebar to trigger response when audio streaming is active
    if (event.code === 'Space' && isAudioStreaming && !event.target.isContentEditable) {
        event.preventDefault();
        triggerRealtimeResponse();
    }
});

// Update UI elements based on streaming state
function updateUIForAudioStreaming(streaming) {
    const triggerBtn = document.getElementById('triggerResponse');
    const micBtn = document.getElementById('microphone');

    if (triggerBtn) {
        triggerBtn.disabled = !streaming;
        triggerBtn.style.display = streaming ? 'inline-block' : 'none';
    }

    if (streaming) {
        console.log('UI updated for audio streaming mode');
    } else {
        console.log('UI updated for fallback mode');
    }
}

function processAudioQueue() {
    if (audioQueue.length === 0) {
        isAvatarSpeaking = false;
        console.log('Audio queue empty - avatar stopped speaking');
        return;
    }

    const audioData = audioQueue.shift();

    try {
        // The audio data from Realtime API is already in a format that can be played
        // Instead of trying to decode it as a complete audio file, we need to handle it as PCM16 data

        // For now, let's skip direct audio playback and let the avatar handle TTS
        // This is because the Realtime API audio format may not be directly compatible
        console.log('Audio response - skipping direct playback, letting avatar handle TTS');

        // Process next audio chunk
        if (audioQueue.length > 0) {
            setTimeout(processAudioQueue, 10);
        } else {
            isAvatarSpeaking = false;
            console.log('Audio queue processed - avatar stopped speaking');
        }

    } catch (error) {
        console.error('Error processing audio queue:', error);
        // Continue with next chunk
        if (audioQueue.length > 0) {
            setTimeout(processAudioQueue, 10);
        } else {
            isAvatarSpeaking = false;
        }
    }
}

// Connect to avatar service with provided configuration
function connectAvatarWithConfig(cogSvcRegion, cogSvcSubKey) {

    // Use private endpoint configuration from server
    if (azureConfig.enablePrivateEndpoint) {
        if (!azureConfig.privateEndpoint) {
            alert('Private endpoint is enabled but not configured. Please check server configuration.');
            return;
        }
        const privateEndpoint = new URL(azureConfig.privateEndpoint).hostname;
        speechSynthesisConfig = SpeechSDK.SpeechConfig.fromEndpoint(
            new URL(`wss://${privateEndpoint}/tts/cognitiveservices/websocket/v1?enableTalkingAvatar=true`), 
            cogSvcSubKey
        );
    } else {
        speechSynthesisConfig = SpeechSDK.SpeechConfig.fromSubscription(cogSvcSubKey, cogSvcRegion);
    }
    // Set custom voice endpoint ID from server configuration
    speechSynthesisConfig.endpointId = azureConfig.customVoiceEndpointId || ''

    // Get avatar configuration from server
    const talkingAvatarCharacter = azureConfig.talkingAvatarCharacter || 'lisa'
    const talkingAvatarStyle = azureConfig.talkingAvatarStyle || 'casual-sitting'
    const avatarConfig = new SpeechSDK.AvatarConfig(talkingAvatarCharacter, talkingAvatarStyle)
    avatarConfig.customized = azureConfig.customAvatar || false
    avatarConfig.useBuiltInVoice = azureConfig.useBuiltInVoice || false
    avatarConfig.backgroundImage = 'https://i.postimg.cc/PxFwBHmh/DXC-HP-Logo.png'
    console.log('AvatarConfig created:', avatarConfig);
    console.log('AvatarConfig backgroundImage:', avatarConfig.backgroundImage);
    
    // Set auto-reconnect and subtitles from server configuration
    const autoReconnect = azureConfig.autoReconnectAvatar !== false // Default to true if not set
    const showSubtitles = azureConfig.showSubtitles !== false // Default to true if not set
    
    // Update UI to reflect server configuration
    document.getElementById('showSubtitles').checked = showSubtitles
    document.getElementById('autoReconnectAvatar').checked = autoReconnect
    avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechSynthesisConfig, avatarConfig)
    avatarSynthesizer.avatarEventReceived = function (s, e) {
        var offsetMessage = ", offset from session start: " + e.offset / 10000 + "ms."
        if (e.offset === 0) {
            offsetMessage = ""
        }

        console.log("Event received: " + e.description + offsetMessage)
    }

    let speechRecognitionConfig
    if (azureConfig.enablePrivateEndpoint) {
        const privateEndpoint = new URL(azureConfig.privateEndpoint).hostname;
        speechRecognitionConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL(`wss://${privateEndpoint}/stt/speech/universal/v2`), cogSvcSubKey) 
    } else {
        speechRecognitionConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL(`wss://${cogSvcRegion}.stt.speech.microsoft.com/speech/universal/v2`), cogSvcSubKey)
    }
    // Always use continuous speech recognition
    speechRecognitionConfig.setProperty(SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous")
    // Get STT locales from server configuration
    const sttLocales = (azureConfig.sttLocales || 'en-US').split(',').map(locale => locale.trim())
    var autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(sttLocales)
    speechRecognizer = SpeechSDK.SpeechRecognizer.FromConfig(speechRecognitionConfig, autoDetectSourceLanguageConfig, SpeechSDK.AudioConfig.fromDefaultMicrophoneInput())

    // Use the stored OpenAI configuration
    const azureOpenAIEndpoint = azureConfig.openAiEndpoint
    const azureOpenAIApiKey = azureConfig.openAiApiKey
    const azureOpenAIDeploymentName = azureConfig.openAiDeploymentName

    dataSources = []
    if (azureConfig.enableOyd) {
        const azureCogSearchEndpoint = azureConfig.cogSearchEndpoint || ''
        const azureCogSearchApiKey = azureConfig.cogSearchApiKey || ''
        const azureCogSearchIndexName = azureConfig.cogSearchIndexName || ''
        
        if (azureCogSearchEndpoint && azureCogSearchApiKey && azureCogSearchIndexName) {
            // Use the configuration from environment variables
            setDataSources(azureCogSearchEndpoint, azureCogSearchApiKey, azureCogSearchIndexName);
        } else {
            console.warn('On Your Data is enabled but Cognitive Search configuration is incomplete. ' +
                       'Please check your environment variables.');
        }
    }

    // Only initialize messages once
    if (!messageInitiated) {
        initMessages()
        messageInitiated = true
    }
    

    document.getElementById('startSession').disabled = true
    document.getElementById('configuration').hidden = true

    const xhr = new XMLHttpRequest()
    if (azureConfig.enablePrivateEndpoint) {
        const privateEndpoint = new URL(azureConfig.privateEndpoint).hostname;
        xhr.open("GET", `https://${privateEndpoint}/tts/cognitiveservices/avatar/relay/token/v1`)
    } else {
        xhr.open("GET", `https://${cogSvcRegion}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1`)
    }
    xhr.setRequestHeader("Ocp-Apim-Subscription-Key", cogSvcSubKey)
    xhr.addEventListener("readystatechange", function() {
        if (this.readyState === 4) {
            const responseData = JSON.parse(this.responseText)
            const iceServerUrl = responseData.Urls[0]
            const iceServerUsername = responseData.Username
            const iceServerCredential = responseData.Password
            setupWebRTC(iceServerUrl, iceServerUsername, iceServerCredential)
        }
    })
    xhr.send()
}

// Disconnect from avatar service
function disconnectAvatar() {
    // Set user closed session flag
    userClosedSession = true;

    // Close realtime WebSocket
    if (realtimeWebSocket) {
        try {
            realtimeWebSocket.close();
        } catch (e) {
            console.error("Error closing realtime WebSocket:", e);
        } finally {
            realtimeWebSocket = null;
        }
    }

    // Stop direct audio streaming
    stopDirectAudioStreaming();

    // Stop and clean up speech recognition
    if (speechRecognizer) {
        try {
            if (speechRecognizer.stopContinuousRecognitionAsync) {
                speechRecognizer.stopContinuousRecognitionAsync(() => {
                    if (speechRecognizer.close) speechRecognizer.close();
                }, (err) => {
                    console.error("Error stopping speech recognition:", err);
                    if (speechRecognizer.close) speechRecognizer.close();
                });
            } else if (speechRecognizer.close) {
                speechRecognizer.close();
            }
        } catch (e) {
            console.error("Error during speech recognizer cleanup:", e);
        } finally {
            speechRecognizer = null;
        }
    }

    // Clean up avatar synthesizer
    if (avatarSynthesizer) {
        try {
            if (avatarSynthesizer.close) {
                avatarSynthesizer.close();
            }
        } catch (e) {
            console.error("Error during avatar synthesizer cleanup:", e);
        } finally {
            avatarSynthesizer = null;
        }
    }

    // Close WebRTC connection if it exists
    if (peerConnection) {
        try {
            peerConnection.close();
        } catch (e) {
            console.error("Error closing peer connection:", e);
        } finally {
            peerConnection = null;
        }
    }

    // Clear audio queue and reset states
    audioQueue = [];
    isAvatarSpeaking = false;
    userSpeechDetected = false;
    speechStartTime = null;
    vadBuffer = [];
    speechEnergyHistory = [];
    interruptionInProgress = false;

    sessionActive = false;
}

// Setup WebRTC
function setupWebRTC(iceServerUrl, iceServerUsername, iceServerCredential) {
    // Create WebRTC peer connection
    peerConnection = new RTCPeerConnection({
        iceServers: [{
            urls: [ iceServerUrl ],
            username: iceServerUsername,
            credential: iceServerCredential
        }]
    })

    // Fetch WebRTC video stream and mount it to an HTML video element
    peerConnection.ontrack = function (event) {
        if (event.track.kind === 'audio') {
            let audioElement = document.createElement('audio')
            audioElement.id = 'audioPlayer'
            audioElement.srcObject = event.streams[0]
            audioElement.autoplay = true

            audioElement.onplaying = () => {
                console.log(`WebRTC ${event.track.kind} channel connected.`)
            }

            // Clean up existing audio element if there is any
            remoteVideoDiv = document.getElementById('remoteVideo')
            for (var i = 0; i < remoteVideoDiv.childNodes.length; i++) {
                if (remoteVideoDiv.childNodes[i].localName === event.track.kind) {
                    remoteVideoDiv.removeChild(remoteVideoDiv.childNodes[i])
                }
            }

            // Append the new audio element
            document.getElementById('remoteVideo').appendChild(audioElement)
        }

        if (event.track.kind === 'video') {
            let videoElement = document.createElement('video')
            videoElement.id = 'videoPlayer'
            videoElement.srcObject = event.streams[0]
            videoElement.autoplay = true
            videoElement.playsInline = true
            videoElement.style.width = '0.5px'

            // Continue speaking if there are unfinished sentences
            if (repeatSpeakingSentenceAfterReconnection) {
                if (speakingText !== '') {
                    speakNext(speakingText, 0, true)
                }
            } else {
                if (spokenTextQueue.length > 0) {
                    speakNext(spokenTextQueue.shift())
                }
            }

            videoElement.onplaying = () => {
                console.log(`WebRTC ${event.track.kind} channel connected.`)

                // Update video element size and UI
                videoElement.style.width = '960px'
                document.getElementById('microphone').disabled = false
                document.getElementById('stopSession').disabled = false
                document.getElementById('remoteVideo').style.width = '960px'
                document.getElementById('chatHistory').hidden = false

                // Enable trigger button if audio streaming is active
                if (isAudioStreaming) {
                    updateUIForAudioStreaming(true);
                }

                if (document.getElementById('useLocalVideoForIdle').checked) {
                    document.getElementById('localVideo').hidden = true
                    if (lastSpeakTime === undefined) {
                        lastSpeakTime = new Date()
                    }
                }

                isReconnecting = false
            }

            // Clean up existing video elements first
            const remoteVideoDiv = document.getElementById('remoteVideo')
            const existingVideos = remoteVideoDiv.querySelectorAll('video');
            existingVideos.forEach(video => video.remove());

            // Append the new video element
            document.getElementById('remoteVideo').appendChild(videoElement)

            setTimeout(() => { sessionActive = true }, 5000) // Set session active after 5 seconds
        }
    }
    
     // Listen to data channel, to get the event from the server
    peerConnection.addEventListener("datachannel", event => {
        peerConnectionDataChannel = event.channel
        peerConnectionDataChannel.onmessage = e => {
            const subtitles = document.getElementById('subtitles');
            const webRTCEvent = JSON.parse(e.data)
            if (webRTCEvent.event.eventType === 'EVENT_TYPE_TURN_START' && document.getElementById('showSubtitles').checked) {
                if (subtitles) subtitles.hidden = false;
                if (subtitles) subtitles.innerHTML = speakingText;
                if (!isAvatarSpeaking) {
                    isAvatarSpeaking = true;  // Mark avatar as speaking
                    console.log('Avatar started speaking (WebRTC event)');
                }
            } else if (webRTCEvent.event.eventType === 'EVENT_TYPE_SESSION_END' || webRTCEvent.event.eventType === 'EVENT_TYPE_SWITCH_TO_IDLE') {
                if (subtitles) subtitles.hidden = true;
                isAvatarSpeaking = false;  // Mark avatar as not speaking
                console.log('Avatar stopped speaking (WebRTC event)');
                if (webRTCEvent.event.eventType === 'EVENT_TYPE_SESSION_END') {
                    if (document.getElementById('autoReconnectAvatar').checked && !userClosedSession && !isReconnecting) {
                        // No longer reconnect when there is no interaction for a while
                        if (new Date() - lastInteractionTime < 300000) {
                            // Session disconnected unexpectedly, need reconnect
                            console.log(`[${(new Date()).toISOString()}] The WebSockets got disconnected, need reconnect.`)
                            isReconnecting = true

                            // Remove data channel onmessage callback to avoid duplicatedly triggering reconnect
                            peerConnectionDataChannel.onmessage = null

                            // Release the existing avatar connection
                            if (avatarSynthesizer !== undefined) {
                                avatarSynthesizer.close()
                            }

                            // Setup a new avatar connection
                            connectAvatar()
                        }
                    }
                }
            }

            console.log("[" + (new Date()).toISOString() + "] WebRTC event received: " + e.data)
        }
    })

    // This is a workaround to make sure the data channel listening is working by creating a data channel from the client side
    c = peerConnection.createDataChannel("eventChannel")

    // Make necessary update to the web page when the connection state changes
    peerConnection.oniceconnectionstatechange = e => {
        console.log("WebRTC status: " + peerConnection.iceConnectionState)
        if (peerConnection.iceConnectionState === 'disconnected') {
            if (document.getElementById('useLocalVideoForIdle').checked) {
                document.getElementById('localVideo').hidden = false
                document.getElementById('remoteVideo').style.width = '0.1px'
            }
        }
    }

    // Offer to receive 1 audio, and 1 video track
    peerConnection.addTransceiver('video', { direction: 'sendrecv' })
    peerConnection.addTransceiver('audio', { direction: 'sendrecv' })

    // start avatar, establish WebRTC connection
    avatarSynthesizer.startAvatarAsync(peerConnection).then((r) => {
        if (r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            console.log("[" + (new Date()).toISOString() + "] Avatar started. Result ID: " + r.resultId)
        } else {
            console.log("[" + (new Date()).toISOString() + "] Unable to start avatar. Result ID: " + r.resultId)
            if (r.reason === SpeechSDK.ResultReason.Canceled) {
                let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(r)
                if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
                    console.log(cancellationDetails.errorDetails)
                };

                console.log("Unable to start avatar: " + cancellationDetails.errorDetails);
            }
            document.getElementById('startSession').disabled = false;
            document.getElementById('configuration').hidden = false;
        }
    }).catch(
        (error) => {
            console.log("[" + (new Date()).toISOString() + "] Avatar failed to start. Error: " + error)
            document.getElementById('startSession').disabled = false
            document.getElementById('configuration').hidden = false
        }
    )
}

// Initialize messages
function initMessages() {
    messages = [];

    if (dataSources.length === 0) {
        let systemMessage = {
            role: 'system',
            content: azureConfig.systemPrompt
        };
        messages.push(systemMessage);
    }
}

// Set data sources for chat API
function setDataSources(azureCogSearchEndpoint, azureCogSearchApiKey, azureCogSearchIndexName) {
    // Get system prompt from configuration or use a default
    const systemPrompt = azureConfig.systemPrompt || 'You are an AI assistant that helps people find information.';
    
    let dataSource = {
        type: 'AzureCognitiveSearch',
        parameters: {
            endpoint: azureCogSearchEndpoint,
            key: azureCogSearchApiKey,
            indexName: azureCogSearchIndexName,
            semanticConfiguration: '',
            queryType: 'simple',
            fieldsMapping: {
                contentFieldsSeparator: '\n',
                contentFields: ['content'],
                filepathField: null,
                titleField: 'title',
                urlField: null
            },
            inScope: true,
            roleInformation: systemPrompt
        }
    };

    // Clear any existing data sources and add the new one
    dataSources = [dataSource];
}

// Do HTML encoding on given text
function htmlEncode(text) {
    const entityMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;'
    };

    return String(text).replace(/[&<>"'\/]/g, (match) => entityMap[match])
}

// Speak the given text
function speak(text, endingSilenceMs = 0) {
    if (isSpeaking) {
        spokenTextQueue.push(text)
        return
    }

    speakNext(text, endingSilenceMs)
}

function speakNext(text, endingSilenceMs = 0, skipUpdatingChatHistory = false) {
    // Use TTS voice from server configuration
    const ttsVoice = azureConfig.ttsVoice || 'en-US-JennyNeural'
    let ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='${ttsVoice}'><mstts:leadingsilence-exact value='0'/>${htmlEncode(text)}</voice></speak>`
    if (endingSilenceMs > 0) {
        ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='${ttsVoice}'><mstts:leadingsilence-exact value='0'/>${htmlEncode(text)}<break time='${endingSilenceMs}ms' /></voice></speak>`
    }

    if (enableDisplayTextAlignmentWithSpeech && !skipUpdatingChatHistory) {
        const chatHistoryTextArea = document.getElementById('chatHistory');
        if (chatHistoryTextArea) {
            chatHistoryTextArea.innerHTML += text.replace(/\n/g, '<br/>');
            chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
        }
    }

    lastSpeakTime = new Date()
    isSpeaking = true
    if (!isAvatarSpeaking) {
        isAvatarSpeaking = true  // Mark avatar as speaking
        console.log('Avatar started speaking (TTS)');
    }
    speakingText = text
    document.getElementById('stopSpeaking').disabled = false
    avatarSynthesizer.speakSsmlAsync(ssml).then(
        (result) => {
            if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
                console.log(`Speech synthesized to speaker for text [ ${text} ]. Result ID: ${result.resultId}`)
                lastSpeakTime = new Date()
            } else {
                console.log(`Error occurred while speaking the SSML. Result ID: ${result.resultId}`)
            }

            speakingText = ''

            if (spokenTextQueue.length > 0) {
                speakNext(spokenTextQueue.shift())
            } else {
                isSpeaking = false
                isAvatarSpeaking = false  // Mark avatar as not speaking
                console.log('Avatar stopped speaking (TTS complete)');
                document.getElementById('stopSpeaking').disabled = true
            }
        }).catch(
            (error) => {
                console.log(`Error occurred while speaking the SSML: [ ${error} ]`)

                speakingText = ''

                if (spokenTextQueue.length > 0) {
                    speakNext(spokenTextQueue.shift())
                } else {
                    isSpeaking = false
                    isAvatarSpeaking = false  // Mark avatar as not speaking
                    console.log('Avatar stopped speaking (TTS error)');
                    document.getElementById('stopSpeaking').disabled = true
                }
            }
        )
}

function stopSpeaking() {
    lastInteractionTime = new Date()
    spokenTextQueue = []
    isAvatarSpeaking = false  // Mark avatar as not speaking
    console.log('Avatar stopped speaking (manual stop)');
    avatarSynthesizer.stopSpeakingAsync().then(
        () => {
            isSpeaking = false
            document.getElementById('stopSpeaking').disabled = true
            console.log("[" + (new Date()).toISOString() + "] Stop speaking request sent.")
        }
    ).catch(
        (error) => {
            console.log("Error occurred while stopping speaking: " + error)
        }
    )
}

function handleUserQuery(userQuery, userQueryHTML, imgUrlPath) {
    lastInteractionTime = new Date()

    // Add user message to messages array
    let contentMessage = userQuery
    if (imgUrlPath.trim()) {
        contentMessage = [
            {
                "type": "text",
                "text": userQuery
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": imgUrlPath
                }
            }
        ]
    }
    let chatMessage = {
        role: 'user',
        content: contentMessage
    }

    messages.push(chatMessage)

    // Display user message in chat history
    const chatHistoryTextArea = document.getElementById('chatHistory');
    if (chatHistoryTextArea) {
        if (chatHistoryTextArea.innerHTML !== '' && !chatHistoryTextArea.innerHTML.endsWith('\n\n')) {
            chatHistoryTextArea.innerHTML += '\n\n';
        }
        chatHistoryTextArea.innerHTML += imgUrlPath.trim() ? "<br/><br/>User: " + userQueryHTML : "<br/><br/>User: " + userQuery + "<br/>";
        chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
    }

    // Stop previous speaking if there is any
    if (isSpeaking) {
        stopSpeaking()
    }

    // For direct audio streaming, we don't need to send text messages
    // The audio is already being streamed to the API
    // This function is now mainly for fallback text input or when audio streaming is not active
    if (!isAudioStreaming && realtimeWebSocket && realtimeWebSocket.readyState === WebSocket.OPEN) {
        console.log('Sending text message to realtime API (fallback mode)');

        const message = {
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: userQuery
                    }
                ]
            }
        };

        realtimeWebSocket.send(JSON.stringify(message));

        // Trigger response
        const responseMessage = {
            type: 'response.create'
        };

        realtimeWebSocket.send(JSON.stringify(responseMessage));

        // Prepare for assistant response in chat history
        if (chatHistoryTextArea) {
            chatHistoryTextArea.innerHTML += '<br/>Assistant: ';
            chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
        }

        // Mark avatar as speaking
        isAvatarSpeaking = true;

    } else if (isAudioStreaming) {
        console.log('Audio streaming active - user speech handled by direct audio stream');
        // Prepare for assistant response in chat history
        if (chatHistoryTextArea) {
            chatHistoryTextArea.innerHTML += '<br/>Assistant: ';
            chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
        }
    } else {
        console.error('Realtime WebSocket is not connected');
        if (chatHistoryTextArea) {
            chatHistoryTextArea.innerHTML += '<br/>Assistant: Sorry, I\'m having trouble connecting. Please try again.<br/>';
            chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
        }
    }
}


function getQuickReply() {
    return quickReplies[Math.floor(Math.random() * quickReplies.length)]
}

function checkHung() {
    // Check whether the avatar video stream is hung, by checking whether the video time is advancing
    let videoElement = document.getElementById('videoPlayer')
    if (videoElement !== null && videoElement !== undefined && sessionActive) {
        let videoTime = videoElement.currentTime
        setTimeout(() => {
            // Check whether the video time is advancing
            if (videoElement.currentTime === videoTime) {
                // Check whether the session is active to avoid duplicatedly triggering reconnect
                if (sessionActive) {
                    sessionActive = false
                    if (document.getElementById('autoReconnectAvatar').checked) {
                        // No longer reconnect when there is no interaction for a while
                        if (new Date() - lastInteractionTime < 300000) {
                            console.log(`[${(new Date()).toISOString()}] The video stream got disconnected, need reconnect.`)
                            isReconnecting = true
                            // Remove data channel onmessage callback to avoid duplicatedly triggering reconnect
                            peerConnectionDataChannel.onmessage = null
                            // Release the existing avatar connection
                            if (avatarSynthesizer !== undefined) {
                                avatarSynthesizer.close()
                            }
    
                            // Setup a new avatar connection
                            connectAvatar()
                        }
                    }
                }
            }
        }, 2000)
    }
}

function checkLastSpeak() {
    if (lastSpeakTime === undefined) {
        return
    }

    let currentTime = new Date()
    if (currentTime - lastSpeakTime > 15000) {
        if (document.getElementById('useLocalVideoForIdle').checked && sessionActive && !isSpeaking) {
            disconnectAvatar()
            document.getElementById('localVideo').hidden = false
            document.getElementById('remoteVideo').style.width = '0.1px'
            sessionActive = false
        }
    }
}

window.onload = () => {
    setInterval(() => {
        checkHung()
        checkLastSpeak()
    }, 2000) // Check session activity every 2 seconds
}

window.startSession = () => {
    lastInteractionTime = new Date()
    if (document.getElementById('useLocalVideoForIdle').checked) {
        document.getElementById('startSession').disabled = true
        document.getElementById('configuration').hidden = true
        document.getElementById('microphone').disabled = false
        document.getElementById('stopSession').disabled = false
        document.getElementById('localVideo').hidden = false
        document.getElementById('remoteVideo').style.width = '0.1px'
        document.getElementById('chatHistory').hidden = false
        document.getElementById('showTypeMessage').disabled = false
        return
    }

    userClosedSession = false
    connectAvatar()
}

window.stopSession = () => {
    try {
        lastInteractionTime = new Date();
        
        // Update UI elements
        const startBtn = document.getElementById('startSession');
        const micBtn = document.getElementById('microphone');
        const stopBtn = document.getElementById('stopSession');
        const configDiv = document.getElementById('configuration');
        const chatHistory = document.getElementById('chatHistory');
        const userMessageBox = document.getElementById('userMessageBox');
        const uploadImgIcon = document.getElementById('uploadImgIcon');
        const localVideo = document.getElementById('localVideo');
        
        if (startBtn) startBtn.disabled = false;
        if (micBtn) {
            micBtn.disabled = true;
            micBtn.innerHTML = 'Start Microphone';
        }
        if (stopBtn) stopBtn.disabled = true;
        if (configDiv) configDiv.hidden = false;
        if (chatHistory) chatHistory.hidden = true;
        if (userMessageBox) userMessageBox.hidden = true;
        if (uploadImgIcon) uploadImgIcon.hidden = true;
        
        const useLocalVideo = document.getElementById('useLocalVideoForIdle');
        if (useLocalVideo && useLocalVideo.checked && localVideo) {
            localVideo.hidden = true;
        }
        
        userClosedSession = true;
        
        // Clean up all resources
        disconnectAvatar();
        
    } catch (error) {
        console.error('Error during session stop:', error);
    }
}

window.clearChatHistory = () => {
    lastInteractionTime = new Date();
    const chatHistory = document.getElementById('chatHistory');
    if (chatHistory) {
        chatHistory.innerHTML = '';
    }
    initMessages();
}

window.microphone = () => {
    lastInteractionTime = new Date()

    if (document.getElementById('microphone').innerHTML === 'Stop Microphone') {
        // Stop microphone and audio streaming
        document.getElementById('microphone').disabled = true

        // Stop direct audio streaming if active
        if (isAudioStreaming) {
            stopDirectAudioStreaming();
        }

        // Stop traditional speech recognition as fallback
        if (speechRecognizer) {
            speechRecognizer.stopContinuousRecognitionAsync(
                () => {
                    document.getElementById('microphone').innerHTML = 'Start Microphone'
                    document.getElementById('microphone').disabled = false
                }, (err) => {
                    console.log("Failed to stop continuous recognition:", err)
                    document.getElementById('microphone').disabled = false
                })
        } else {
            document.getElementById('microphone').innerHTML = 'Start Microphone'
            document.getElementById('microphone').disabled = false
        }

        return
    }

    if (document.getElementById('useLocalVideoForIdle').checked) {
        if (!sessionActive) {
            connectAvatar()
        }

        setTimeout(() => {
            document.getElementById('audioPlayer').play()
        }, 5000)
    } else {
        document.getElementById('audioPlayer').play()
    }

    document.getElementById('microphone').disabled = true

    // If direct audio streaming is available and realtime API is connected, use it
    if (realtimeWebSocket && realtimeWebSocket.readyState === WebSocket.OPEN && !isAudioStreaming) {
        console.log('Starting optimized audio streaming mode');
        startDirectAudioStreaming();
        document.getElementById('microphone').innerHTML = 'Stop Microphone'
        document.getElementById('microphone').disabled = false
        return;
    }

    // Note: Speech recognition is now handled by direct audio streaming to Realtime API
    // Keep this for fallback/compatibility, but primary path is through audio streaming
    speechRecognizer.recognized = async (s, e) => {
        if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
            let userQuery = e.result.text.trim()
            if (userQuery === '') {
                return
            }

            // Only use this fallback if direct audio streaming is not active
            if (!isAudioStreaming) {
                console.log('Using fallback speech recognition:', userQuery);

                // Auto stop microphone when a phrase is recognized, when it's not continuous conversation mode
                if (!document.getElementById('continuousConversation').checked) {
                    document.getElementById('microphone').disabled = true
                    speechRecognizer.stopContinuousRecognitionAsync(
                        () => {
                            document.getElementById('microphone').innerHTML = 'Start Microphone'
                            document.getElementById('microphone').disabled = false
                        }, (err) => {
                            console.log("Failed to stop continuous recognition:", err)
                            document.getElementById('microphone').disabled = false
                        })
                }

                handleUserQuery(userQuery,"","")
            }
        }
    }

    speechRecognizer.startContinuousRecognitionAsync(
        () => {
            document.getElementById('microphone').innerHTML = 'Stop Microphone'
            document.getElementById('microphone').disabled = false
        }, (err) => {
            console.log("Failed to start continuous recognition:", err)
            document.getElementById('microphone').disabled = false
        })
}

window.updataEnableOyd = () => {
    // This function is kept for compatibility but the checkbox is now managed via environment variable
    document.getElementById('cogSearchConfig').hidden = !azureConfig.enableOyd;
    
    // Reinitialize messages when toggling OYD
    initMessages();
}

window.updateTypeMessageBox = () => {
    if (document.getElementById('showTypeMessage').checked) {
        document.getElementById('userMessageBox').hidden = false
        document.getElementById('uploadImgIcon').hidden = false
        document.getElementById('userMessageBox').addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                const userQuery = document.getElementById('userMessageBox').innerText
                const messageBox = document.getElementById('userMessageBox')
                const childImg = messageBox.querySelector("#picInput")
                if (childImg) {
                    childImg.style.width = "200px"
                    childImg.style.height = "200px"
                }
                let userQueryHTML = messageBox.innerHTML.trim("")
                if(userQueryHTML.startsWith('<img')){
                    userQueryHTML="<br/>"+userQueryHTML
                }
                if (userQuery !== '') {
                    handleUserQuery(userQuery.trim(''), userQueryHTML, imgUrl)
                    document.getElementById('userMessageBox').innerHTML = ''
                    imgUrl = ""
                }
            }
        })
        document.getElementById('uploadImgIcon').addEventListener('click', function() {
            imgUrl = "https://wallpaperaccess.com/full/528436.jpg"
            const userMessage = document.getElementById("userMessageBox");
            const childImg = userMessage.querySelector("#picInput");
            if (childImg) {
                userMessage.removeChild(childImg)
            }
            userMessage.innerHTML+='<br/><img id="picInput" src="https://wallpaperaccess.com/full/528436.jpg" style="width:100px;height:100px"/><br/><br/>'   
        });
    } else {
        document.getElementById('userMessageBox').hidden = true
        document.getElementById('uploadImgIcon').hidden = true
    }
}

window.updateLocalVideoForIdle = () => {
    document.getElementById('localVideo').hidden = !document.getElementById('useLocalVideoForIdle').checked
}

// Keep this function for backward compatibility but make it use the server config
window.updatePrivateEndpoint = () => {
    // This function is kept for compatibility but the private endpoint is now managed via environment variable
    document.getElementById('showPrivateEndpointCheckBox').hidden = !azureConfig.enablePrivateEndpoint;
    
    if (!azureConfig.enablePrivateEndpoint) {
        document.getElementById('privateEndpoint').value = '';
    }
}

// Keep this function for backward compatibility but make it use the server config
window.updateCustomAvatarBox = () => {
    // This function is kept for compatibility but the custom avatar is now managed via environment variable
    document.getElementById('useBuiltInVoice').disabled = !azureConfig.customAvatar;
}


// Mute functionality
let isMuted = false;

const toggleMute = () => {
    isMuted = !isMuted;
    const muteButton = document.getElementById('toggleMute');
    const icon = muteButton.querySelector('i');
    const muteText = muteButton.querySelector('.mute-text');
    
    if (isMuted) {
        // Muted state
        icon.className = 'fas fa-microphone-slash';
        muteText.textContent = ' Unmute';
        
        // Mute the microphone by stopping all tracks in the media stream
        if (mediaStream) {
            mediaStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });
        }
    } else {
        // Unmuted state
        icon.className = 'fas fa-microphone';
        muteText.textContent = ' Mute';
        
        // Unmute the microphone by enabling all audio tracks
        if (mediaStream) {
            mediaStream.getAudioTracks().forEach(track => {
                track.enabled = true;
            });
        }
    }
};

// Add event listener for the mute button
document.addEventListener('DOMContentLoaded', () => {
    const muteButton = document.getElementById('toggleMute');
    if (muteButton) {
        muteButton.addEventListener('click', toggleMute);
    }
    
    // Make sure startSession is available globally
    window.startSession = startSession;
});

// Add keyboard shortcut for mute (Ctrl+Shift+M)
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        toggleMute();
    }
});
