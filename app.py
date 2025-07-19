import logging
import os
from pathlib import Path

from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import AzureDeveloperCliCredential, DefaultAzureCredential
from dotenv import load_dotenv

# Removed MCP and web search tools for simplified setup
from rtmt import RTMiddleTier

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voicerag")

DIXIE_PROMPT = """
You are Dixie, a kind and emotionally intelligent Digital Human Avatar created by DXC Technology. Your mission is to provide calm, friendly, and effective technical support for everyday IT issues like password resets, system slowness, login problems, and connectivity interruptions.

You communicate in a natural, human-like tone, responding with empathy and understanding. Always aim to make the user feel supported, never overwhelmed. Keep your tone calm, confident, and conversational—like you're a trusted colleague helping out.

To begin a new conversation, say: "Hi, I'm Dixie, the Digital Human Avatar from DXC Technology. I'm here to help with your tech issue—what seems to be the problem today?"

Throughout the interaction:
- Acknowledge user frustration or urgency with empathy. Use phrases like: "That sounds frustrating, but I'm here to help." or "No worries, we’ll work through this together."
- Avoid robotic or overly scripted responses. Speak naturally.
- When giving instructions, guide step-by-step:
  "Let’s start by checking your connection."
  "Next, try restarting your device."
  "Now, let’s reset the password…"

If a user’s question isn’t clear, gently prompt for more information:
"Could you tell me what you see on your screen?" or "Did this start happening just today?"

If the issue needs escalation, say: "This might require a specialist. I can schedule a call with our help desk team. Would 3 PM EST on Tuesday or 10 AM EST on Wednesday work for you?"
If something is beyond your ability to fix, respond with: "That’s a bit beyond what I can resolve directly, but I’ll make sure the right person steps in to assist."

Important Answering Rule:
- If the question is related to the event content below, answer strictly using that content.
- If the question is general or unrelated to the event, use your general technical knowledge.

Event Content: HP Tech Day

Title: The AI Revolution – How AI is Reshaping Our World and Transforming Business

Overview:
DXC Technology invites you to an exclusive on-campus event showcasing cutting-edge advancements in artificial intelligence. Join us for an interactive session that explores how DXC’s latest AI innovations are driving meaningful transformation and solving real-world challenges.

Details:
Location: HP Springs Office – The Hub (next to the cafeteria)
Date: July 22, 2025
Time: 11:00 AM – 1:00 PM

Featured Presentations:
1. Angela Daniels – AI in Software Engineering: A deep dive into DXC’s Converge Gen AI Platform and how it accelerates the software engineering lifecycle.
2. Neil Waller – Applications Modernization Studio: Learn how DXC is using AI to help businesses modernize applications faster with end-to-end transformation.
3. Steve Nahas – Agentic AI in Supply Chain: Discover how DXC is deploying intelligent supply chains with SAP Business AI and Databricks in the S/4HANA cloud.

Invitation Note:
Your presence as a leader at HP is highly valued. We look forward to engaging with you at this exciting event.

– The DXC Team
"""

async def create_app():
    if not os.environ.get("RUNNING_IN_PRODUCTION"):
        logger.info("Running in development mode, loading from .env file")
        load_dotenv()

    llm_key = os.environ.get("AZURE_OPENAI_API_KEY")

    credential = None
    if not llm_key:
        if tenant_id := os.environ.get("AZURE_TENANT_ID"):
            logger.info("Using AzureDeveloperCliCredential with tenant_id %s", tenant_id)
            credential = AzureDeveloperCliCredential(tenant_id=tenant_id, process_timeout=60)
        else:
            logger.info("Using DefaultAzureCredential")
            credential = DefaultAzureCredential()
    llm_credential = AzureKeyCredential(llm_key) if llm_key else credential
    
    app = web.Application()

    rtmt = RTMiddleTier(
        credentials=llm_credential,
        endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        deployment=os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT"],
        voice_choice=os.environ.get("AZURE_OPENAI_REALTIME_VOICE_CHOICE") or "alloy"
        )
    # Build system message from environment variables (Dixie avatar prompts)
    prompt_parts = [
        os.environ.get("SYSTEM_PROMPT_PART1", ""),
        os.environ.get("SYSTEM_PROMPT_PART2", ""),
        os.environ.get("SYSTEM_PROMPT_PART3", ""),
        os.environ.get("SYSTEM_PROMPT_PART4", ""),
        os.environ.get("SYSTEM_PROMPT_PART5", "")
    ]
    #dixie_prompt = '\n\n'.join(part for part in prompt_parts if part)
    dixie_prompt = DIXIE_PROMPT

    # Use Dixie's personality for the avatar
    rtmt.system_message = f"""
{dixie_prompt}

TECHNICAL CAPABILITIES:
You are a helpful digital human avatar. Keep your responses concise and conversational since users are listening with audio.
Focus on being supportive and empathetic while providing helpful technical assistance.

RESPONSE INSTRUCTIONS:
1. Keep answers conversational and supportive, matching Dixie's personality
2. Provide clear, step-by-step guidance for technical issues
3. Use empathetic language when users are frustrated
4. Keep responses brief but complete
5. If you don't know something, acknowledge it honestly and suggest next steps
6. If user interrupts you, respond politely.
7. Limit your responses to 2-3 sentences.
    """.strip()

    # Simplified setup without MCP and web search tools
    logger.info("Avatar realtime API backend initialized")

    rtmt.attach_to_app(app, "/realtime")

    current_directory = Path(__file__).parent
    public_path = current_directory / 'Public'

    # Serve avatar frontend files
    if public_path.exists():
        # Serve static files (CSS, JS, images)
        app.router.add_static('/css', path=public_path / 'css', name='css')
        app.router.add_static('/js', path=public_path / 'js', name='js')
        app.router.add_static('/image', path=public_path / 'image', name='image')

        # Serve HTML pages
        async def serve_chat(_):
            return web.FileResponse(public_path / 'chat.html')

        # Add routes
        app.add_routes([
            web.get('/', serve_chat),  # Default to chat
            web.get('/chat', serve_chat)
        ])

        logger.info(f"Serving avatar frontend from {public_path}")
    else:
        # Fallback for development
        async def dev_handler(_):
            return web.Response(text="Avatar frontend not found. Please check Public directory.", content_type='text/plain')
        app.add_routes([web.get('/', dev_handler)])
        logger.warning(f"Public path {public_path} not found")

    # Add Azure configuration endpoint for frontend
    async def azure_config_handler(_):
        # Build system prompt from parts
        prompt_parts = [
            os.environ.get("SYSTEM_PROMPT_PART1", ""),
            os.environ.get("SYSTEM_PROMPT_PART2", ""),
            os.environ.get("SYSTEM_PROMPT_PART3", ""),
            os.environ.get("SYSTEM_PROMPT_PART4", ""),
            os.environ.get("SYSTEM_PROMPT_PART5", "")
        ]
        #system_prompt = '\n\n'.join(part for part in prompt_parts if part)
        system_prompt = DIXIE_PROMPT

        if not system_prompt:
            system_prompt = "You are an AI assistant that helps with technical support."

        config = {
            # Speech Service Configuration
            'speechRegion': os.environ.get('SPEECH_REGION', ''),
            'speechApiKey': os.environ.get('SPEECH_API_KEY', ''),

            # OpenAI Configuration (legacy compatibility)
            'openAiEndpoint': os.environ.get('OPENAI_ENDPOINT', ''),
            'openAiApiKey': os.environ.get('OPENAI_API_KEY', ''),
            'openAiDeploymentName': os.environ.get('OPENAI_DEPLOYMENT_NAME', ''),

            # Realtime API Configuration
            # 'realtimeEndpoint': f"ws://localhost:5000/realtime",  # WebSocket endpoint for realtime API
            'realtimeEndpoint': "wss://digital-human-avatar-realtime-api-a3e2hcdxf6bcdga7.eastus-01.azurewebsites.net/realtime",
            'azureOpenAiEndpoint': os.environ.get('AZURE_OPENAI_ENDPOINT', ''),
            'azureOpenAiApiKey': os.environ.get('AZURE_OPENAI_API_KEY', ''),
            'azureOpenAiDeployment': os.environ.get('AZURE_OPENAI_REALTIME_DEPLOYMENT', ''),

            # Private Endpoint Configuration
            'enablePrivateEndpoint': os.environ.get('ENABLE_PRIVATE_ENDPOINT', 'false').lower() == 'true',
            'privateEndpoint': os.environ.get('PRIVATE_ENDPOINT', ''),

            # Chat Configuration
            'systemPrompt': system_prompt,

            # On Your Data Configuration
            'enableOyd': os.environ.get('ENABLE_OYD', 'false').lower() == 'true',
            'cogSearchEndpoint': os.environ.get('COG_SEARCH_ENDPOINT', ''),
            'cogSearchApiKey': os.environ.get('COG_SEARCH_API_KEY', ''),
            'cogSearchIndexName': os.environ.get('COG_SEARCH_INDEX_NAME', ''),

            # STT/TTS Configuration
            'sttLocales': os.environ.get('STT_LOCALES', 'en-US'),
            'ttsVoice': os.environ.get('TTS_VOICE', 'en-US-JennyNeural'),
            'customVoiceEndpointId': os.environ.get('CUSTOM_VOICE_ENDPOINT_ID', ''),

            # Avatar Configuration
            'talkingAvatarCharacter': os.environ.get('TALKING_AVATAR_CHARACTER', 'lisa'),
            'talkingAvatarStyle': os.environ.get('TALKING_AVATAR_STYLE', 'casual-sitting'),
            'customAvatar': os.environ.get('CUSTOM_AVATAR', 'false').lower() == 'true',
            'useBuiltInVoice': os.environ.get('USE_BUILT_IN_VOICE', 'false').lower() == 'true',
            'autoReconnectAvatar': os.environ.get('AUTO_RECONNECT_AVATAR', 'true').lower() == 'true',
            'showSubtitles': os.environ.get('SHOW_SUBTITLES', 'true').lower() == 'true'
        }

        return web.json_response(config)

    app.add_routes([web.get('/azure-config', azure_config_handler)])
    
    return app

if __name__ == "__main__":
    host = "0.0.0.0"
    port = 5000
    web.run_app(create_app(), host=host, port=port)
