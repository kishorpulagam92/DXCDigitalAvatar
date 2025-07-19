import asyncio
import json
import logging
from enum import Enum
from typing import Any, Callable, Optional

import aiohttp
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

logger = logging.getLogger("voicerag")

class ToolResultDirection(Enum):
    TO_SERVER = 1
    TO_CLIENT = 2

class ToolResult:
    text: str
    destination: ToolResultDirection

    def __init__(self, text: str, destination: ToolResultDirection):
        self.text = text
        self.destination = destination

    def to_text(self) -> str:
        if self.text is None:
            return ""
        return self.text if type(self.text) == str else json.dumps(self.text)

class Tool:
    target: Callable[..., ToolResult]
    schema: Any

    def __init__(self, target: Any, schema: Any):
        self.target = target
        self.schema = schema

class RTToolCall:
    tool_call_id: str
    previous_id: str

    def __init__(self, tool_call_id: str, previous_id: str):
        self.tool_call_id = tool_call_id
        self.previous_id = previous_id

class RTMiddleTier:
    endpoint: str
    deployment: str
    key: Optional[str] = None
    
    # Tools are server-side only for now, though the case could be made for client-side tools
    # in addition to server-side tools that are invisible to the client
    tools: dict[str, Tool] = {}

    # Server-enforced configuration, if set, these will override the client's configuration
    # Typically at least the model name and system message will be set by the server
    model: Optional[str] = None
    system_message: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    disable_audio: Optional[bool] = None
    voice_choice: Optional[str] = None
    api_version: str = "2024-10-01-preview"
    _tools_pending = {}
    _token_provider = None

    def __init__(self, endpoint: str, deployment: str, credentials: AzureKeyCredential | DefaultAzureCredential, voice_choice: Optional[str] = None):
        self.endpoint = endpoint
        self.deployment = deployment
        self.voice_choice = voice_choice
        if voice_choice is not None:
            logger.info("Realtime voice choice set to %s", voice_choice)
        if isinstance(credentials, AzureKeyCredential):
            self.key = credentials.key
        else:
            self._token_provider = get_bearer_token_provider(credentials, "https://cognitiveservices.azure.com/.default")
            self._token_provider() # Warm up during startup so we have a token cached when the first request arrives

    async def _process_message_to_client(self, msg: str, client_ws: web.WebSocketResponse, server_ws: web.WebSocketResponse) -> Optional[str]:
        message = json.loads(msg.data)
        updated_message = msg.data
        if message is not None:
            match message["type"]:
                case "session.created":
                    session = message["session"]
                    # Hide the instructions, tools and max tokens from clients, if we ever allow client-side 
                    # tools, this will need updating
                    session["instructions"] = ""
                    session["tools"] = []
                    session["voice"] = self.voice_choice
                    session["tool_choice"] = "none"
                    session["max_response_output_tokens"] = None
                    updated_message = json.dumps(message)

                case "response.output_item.added":
                    if "item" in message and message["item"]["type"] == "function_call":
                        updated_message = None

                case "conversation.item.created":
                    if "item" in message and message["item"]["type"] == "function_call":
                        item = message["item"]
                        if item["call_id"] not in self._tools_pending:
                            self._tools_pending[item["call_id"]] = RTToolCall(item["call_id"], message["previous_item_id"])
                        updated_message = None
                    elif "item" in message and message["item"]["type"] == "function_call_output":
                        updated_message = None

                case "response.function_call_arguments.delta":
                    updated_message = None
                
                case "response.function_call_arguments.done":
                    updated_message = None

                case "response.output_item.done":
                    if "item" in message and message["item"]["type"] == "function_call":
                        item = message["item"]
                        tool_call = self._tools_pending[message["item"]["call_id"]]
                        tool = self.tools[item["name"]]
                        args_str = item["arguments"]

                        # Parse arguments once and reuse
                        try:
                            args_dict = json.loads(args_str)
                        except json.JSONDecodeError as e:
                            print(f"❌ Error parsing tool arguments: {e}")
                            print(f"   Raw arguments: {args_str}")
                            args_dict = {}

                        # Send intermediate feedback to UI only (no audio to avoid double voice)
                        print(f"💬 Sending intermediate feedback for tool: {item['name']}")
                        try:
                            feedback_text = await self._send_intermediate_feedback_to_ui(client_ws, server_ws, item["name"], args_dict)
                        except Exception as feedback_error:
                            print(f"⚠️ Intermediate feedback failed: {feedback_error}")

                        # Small delay for UI update
                        await asyncio.sleep(0.1)

                        print(f"🔧 Executing tool: {item['name']}")
                        result = await tool.target(args_dict)
                        await server_ws.send_json({
                            "type": "conversation.item.create",
                            "item": {
                                "type": "function_call_output",
                                "call_id": item["call_id"],
                                "output": result.to_text() if result.destination == ToolResultDirection.TO_SERVER else ""
                            }
                        })
                        if result.destination == ToolResultDirection.TO_CLIENT:
                            # TODO: this will break clients that don't know about this extra message, rewrite
                            # this to be a regular text message with a special marker of some sort
                            await client_ws.send_json({
                                "type": "extension.middle_tier_tool_response",
                                "previous_item_id": tool_call.previous_id,
                                "tool_name": item["name"],
                                "tool_result": result.to_text()
                            })
                        updated_message = None

                case "response.done":
                    if len(self._tools_pending) > 0:
                        self._tools_pending.clear() # Any chance tool calls could be interleaved across different outstanding responses?
                        await server_ws.send_json({
                            "type": "response.create"
                        })
                    if "response" in message and "output" in message["response"]:
                        replace = False
                        # Create a new output list without function calls
                        new_output = []
                        for output in message["response"]["output"]:
                            if output.get("type") != "function_call":
                                new_output.append(output)
                            else:
                                replace = True

                        if replace:
                            message["response"]["output"] = new_output
                            updated_message = json.dumps(message)

        return updated_message

    async def _process_message_to_server(self, msg: str, ws: web.WebSocketResponse) -> Optional[str]:
        message = json.loads(msg.data)
        updated_message = msg.data
        if message is not None:
            match message["type"]:
                case "session.update":
                    session = message["session"]
                    if self.system_message is not None:
                        session["instructions"] = self.system_message
                    if self.temperature is not None:
                        session["temperature"] = self.temperature
                    if self.max_tokens is not None:
                        session["max_response_output_tokens"] = self.max_tokens
                    if self.disable_audio is not None:
                        session["disable_audio"] = self.disable_audio
                    if self.voice_choice is not None:
                        session["voice"] = self.voice_choice
                    session["tool_choice"] = "auto" if len(self.tools) > 0 else "none"
                    session["tools"] = [tool.schema for tool in self.tools.values()]
                    updated_message = json.dumps(message)

        return updated_message

    async def _send_intermediate_feedback_to_ui(self, client_ws: web.WebSocketResponse, server_ws: web.WebSocketResponse, tool_name: str, args: dict) -> str:
        """
        Send intermediate feedback to the UI to show what the agent is doing
        while waiting for tool execution (especially web search)
        Returns the feedback text that was sent
        """
        try:
            feedback_messages = {
                "search": self._get_search_feedback_message(args),
                "search_with_routing": self._get_search_feedback_message(args),
                "web_search": "Let me search the web for that information.",
                "report_grounding": "I'm gathering the relevant information for you.",
                "search_documents": "I'm searching through the knowledge base.",
                "get_document": "I'm retrieving that document.",
                "suggest_documents": "Let me find some related documents.",
                "autocomplete": "I'm looking up suggestions for you."
            }

            feedback_text = feedback_messages.get(tool_name, f"I'm working on that using {tool_name}.")
            print(f"💬 Intermediate feedback: '{feedback_text}' for tool '{tool_name}'")

            # Send feedback message directly to the client UI
            await client_ws.send_json({
                "type": "extension.intermediate_feedback",
                "feedback_text": feedback_text,
                "tool_name": tool_name,
                "timestamp": asyncio.get_event_loop().time()
            })

            # Skip audio feedback to avoid double audio - just show in UI
            print("💬 Skipping audio feedback to avoid double audio (UI feedback is sufficient)")

            print("💬 Intermediate feedback sent to UI successfully")
            return feedback_text

        except Exception as e:
            print(f"❌ Error sending intermediate feedback: {e}")
            import traceback
            traceback.print_exc()
            return ""

    def _get_search_feedback_message(self, args: dict) -> str:
        """
        Generate contextual feedback message for search operations
        """
        query = args.get('query', '')

        # Provide more specific feedback based on query content
        if any(term in query.lower() for term in ['weather', 'temperature', 'forecast']):
            return "Let me check the current weather for you."
        elif any(term in query.lower() for term in ['news', 'latest', 'recent', 'breaking']):
            return "I'm searching for the latest news on that topic."
        elif any(term in query.lower() for term in ['stock', 'price', 'market', 'trading']):
            return "Let me look up the current market information."
        elif any(term in query.lower() for term in ['dxc', 'company', 'service', 'solution']):
            return "I'm searching our knowledge base for that information."
        elif 'search' in query.lower() or 'find' in query.lower() or 'look up' in query.lower():
            return "I'm searching the web for that information."
        else:
            return "Let me find that information for you."

    async def _forward_messages(self, ws: web.WebSocketResponse):
        async with aiohttp.ClientSession(base_url=self.endpoint) as session:
            params = { "api-version": self.api_version, "deployment": self.deployment}
            headers = {}
            if "x-ms-client-request-id" in ws.headers:
                headers["x-ms-client-request-id"] = ws.headers["x-ms-client-request-id"]
            if self.key is not None:
                headers = { "api-key": self.key }
            else:
                headers = { "Authorization": f"Bearer {self._token_provider()}" } # NOTE: no async version of token provider, maybe refresh token on a timer?
            async with session.ws_connect("/openai/realtime", headers=headers, params=params) as target_ws:
                async def from_client_to_server():
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            new_msg = await self._process_message_to_server(msg, ws)
                            if new_msg is not None:
                                await target_ws.send_str(new_msg)
                        else:
                            print("Error: unexpected message type:", msg.type)
                    
                    # Means it is gracefully closed by the client then time to close the target_ws
                    if target_ws:
                        print("Closing OpenAI's realtime socket connection.")
                        await target_ws.close()
                        
                async def from_server_to_client():
                    async for msg in target_ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            new_msg = await self._process_message_to_client(msg, ws, target_ws)
                            if new_msg is not None:
                                await ws.send_str(new_msg)
                        else:
                            print("Error: unexpected message type:", msg.type)

                try:
                    await asyncio.gather(from_client_to_server(), from_server_to_client())
                except ConnectionResetError:
                    # Ignore the errors resulting from the client disconnecting the socket
                    pass

    async def _websocket_handler(self, request: web.Request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await self._forward_messages(ws)
        return ws
    
    def attach_to_app(self, app, path):
        app.router.add_get(path, self._websocket_handler)
