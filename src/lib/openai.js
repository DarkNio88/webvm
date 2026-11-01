import { get, writable } from 'svelte/store';
import { browser } from '$app/environment'
import { aiActivity } from '$lib/activities.js'
import { tryPlausible } from '$lib/plausible.js';

import OpenAI from 'openai';

var client = null;
var messages = [];
var stopFlag = false;
var lastScreenshot = null;
var screenshotCanvas = null;
var screenshotCtx = null;

export function setApiKey(key)
{
	client = new OpenAI({baseURL: "https://ai.s2.darknio.ovh/v1", apiKey: key, dangerouslyAllowBrowser: true});
	// Reset messages
	messages = []
	messageList.set(messages);
	localStorage.setItem("openai-api-key", key);
	apiState.set("READY");
	tryPlausible("OpenAI Key");
}

function clearApiKey()
{
	localStorage.removeItem("openai-api-key");
	apiState.set("KEY_REQUIRED");
}

function addMessageInternal(role, content)
{
	messages.push({role: role, content: content});
	messageList.set(messages);
}

// NOTE: tool payloads in message history are stored in normalized internal form:
//   assistant tool call: { type: "tool_use", id, name, input }
//   user tool result:    { type: "tool_result", tool_use_id, content, is_error }
// They are translated to OpenAI wire format in toOpenAIMessages().
var tools = null;

function getToolsDefinition()
{
	var dc = get(displayConfig);
	if(dc)
	{
		return [{
			type: "function",
			function: {
				name: "computer",
				description: "Control the virtual machine desktop display. Use mouse, keyboard and take screenshots to interact with the GUI.",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["screenshot", "mouse_move", "left_click", "right_click", "type", "key", "wait"],
							description: "The action to perform"
						},
						coordinate: {
							type: "array",
							items: { type: "integer" },
							description: "X,Y pixel coordinates for mouse actions (required for mouse_move, left_click, right_click)"
						},
						text: {
							type: "string",
							description: "Text to type (for 'type' action) or key name (for 'key' action, e.g. 'Return', 'Escape', 'ctrl+c')"
						},
						duration: {
							type: "integer",
							description: "Seconds to wait (required for 'wait' action)"
						}
					},
					required: ["action"]
				}
			}
		}];
	}
	return [{
		type: "function",
		function: {
			name: "bash",
			description: "Run a shell command on the virtualized Linux machine and return its combined output.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The shell command to execute"
					}
				},
				required: ["command"]
			}
		}
	}];
}

function toOpenAIMessages()
{
	var out = [];
	for(var i=0;i<messages.length;i++)
	{
		var m = messages[i];
		if(m.role == "user" || m.role == "assistant")
		{
			if(typeof m.content == "string")
			{
				out.push({role: m.role, content: m.content});
				continue;
			}
			// Array content: split tool calls / plain text
			var parts = Array.isArray(m.content) ? m.content : [m.content];
			var text = [];
			var toolCalls = [];
			var toolResults = [];
			for(var j=0;j<parts.length;j++)
			{
				var p = parts[j];
				if(typeof p == "string")
				{
					text.push(p);
				}
				else if(p.type == "tool_use")
				{
					toolCalls.push({id: p.id, type: "function", function: {name: p.name, arguments: JSON.stringify(p.input)}});
				}
				else if(p.type == "tool_result")
				{
					toolResults.push(p);
				}
				else if(p.type == "image")
				{
					text.push({type: "image_url", image_url: {url: "data:image/png;base64," + p.source.data}});
				}
			}
			if(m.role == "assistant")
			{
				var msg = {role: "assistant", content: text.length ? text.join("\n") : (toolCalls.length ? "" : null)};
				if(toolCalls.length)
					msg.tool_calls = toolCalls;
				out.push(msg);
			}
			else
			{
				// Tool results must be sent as individual 'tool' messages
				for(var k=0;k<toolResults.length;k++)
				{
					var tr = toolResults[k];
					var content;
					if(Array.isArray(tr.content))
						content = tr.content.map(function(c) {
							if(c.type == "image")
								return {type: "image_url", image_url: {url: "data:image/png;base64," + c.source.data}};
							return {type: "text", text: String(c.text !== undefined ? c.text : c)};
						});
					else
						content = tr.content !== undefined ? String(tr.content) : "";
					out.push({role: "tool", tool_call_id: tr.tool_use_id, content: content});
				}
				// Any remaining plain text from the user
				if(text.length && !toolResults.length)
					out.push({role: "user", content: text.join("\n")});
			}
		}
	}
	return out;
}

async function sendMessages(handleTool)
{
	aiActivity.set(true);
	try
	{
		const config = {
			max_completion_tokens: 2048,
			messages: [
				{role: "system", content: "You are running on a virtualized machine. Wait some extra time after all operations to compensate for slowdown."},
				...toOpenAIMessages()
			],
			model: 'glm-5.3-flash-free',
			tools: tools,
			tool_choice: "auto"
		};
		const response = await client.chat.completions.create(config);
		if(stopFlag)
		{
			aiActivity.set(false);
			return;
		}
		// Remove all the image payloads, we don't want to send them over and over again
		for(var i=0;i<messages.length;i++)
		{
			var c = messages[i].content;
			if(Array.isArray(c))
			{
				if(c[0].type == "tool_result" && c[0].content && c[0].content[0].type == "image")
					delete c[0].content;
			}
		}
		var content = response.choices[0].message;
		// Assistant text
		if(content.content)
			addMessageInternal(response.choices[0].message.role, content.content);
		// Handle tool calls (sequential, single at a time)
		var toolCalls = content.tool_calls || [];
		for(var j=0;j<toolCalls.length;j++)
		{
			var tc = toolCalls[j];
			var input;
			try
			{
				input = JSON.parse(tc.function.arguments || "{}");
			}
			catch(e)
			{
				input = {};
			}
			var toolUse = {type: "tool_use", id: tc.id, name: tc.function.name, input: input};
			addMessageInternal("assistant", [toolUse]);
			var commandResponse = await handleTool(input);
			var responseObj = {type: "tool_result", tool_use_id: tc.id};
			if(commandResponse != null)
			{
				if(commandResponse instanceof Error)
				{
					console.warn(`Tool error: ${commandResponse.message}`);
					responseObj.content = commandResponse.message;
					responseObj.is_error = true;
				}
				else
				{
					responseObj.content = commandResponse;
				}
			}
			addMessageInternal("user", [responseObj]);
			if(stopFlag)
			{
				// Maintain state consitency by stopping after adding a valid response
				aiActivity.set(false);
				return;
			}
			sendMessages(handleTool);
			return;
		}
		if(!toolCalls.length && response.choices[0].finish_reason == "stop")
		{
			tryPlausible("OpenAI Success");
			aiActivity.set(false);
		}
	}
	catch(e)
	{
		tryPlausible("OpenAI Error");
		if(e.status == 401)
		{
			addMessageInternal('error', 'Invalid API key');
			clearApiKey();
		}
		else
		{
			addMessageInternal('error', e.message || String(e));
		}
	}
}

export function addMessage(text, handleTool)
{
	addMessageInternal('user', text);
	sendMessages(handleTool);
	tryPlausible("OpenAI Use");
}

export function clearMessageHistory() {
	messages.length = 0;
	messageList.set(messages);
}

export function forceStop() {
    stopFlag = true;
    return new Promise((resolve) => {
        const unsubscribe = aiActivity.subscribe((value) => {
            if (!value) {
                unsubscribe();
				stopFlag = false;
                resolve();
            }
        });
    });
}

export function getMessageDetails(msg) {
	const isToolUse = Array.isArray(msg.content) && msg.content[0].type === "tool_use";
	const isToolResult = Array.isArray(msg.content) && msg.content[0].type === "tool_result";
	let icon = "";
	let messageContent = "";

	if (isToolUse) {
		let tool = msg.content[0].input;
		if(tool.name == "bash" && tool.command) {
			icon = "fa-terminal";
			messageContent = `Run: ${tool.command}`;
		}
		else if (tool.action === "screenshot") {
			icon = "fa-desktop";
			messageContent = "Screenshot";
		} else if (tool.action === "mouse_move") {
			icon = "fa-mouse-pointer";
			var coords = tool.coordinate;
			messageContent = `Mouse at (${coords[0]}, ${coords[1]})`;
		} else if (tool.action === "left_click") {
			icon = "fa-mouse-pointer";
			var coords = tool.coordinate;
			messageContent = `Left click at (${coords[0]}, ${coords[1]})`;
		} else if (tool.action === "right_click") {
			icon = "fa-mouse-pointer";
			var coords = tool.coordinate;
			messageContent = `Right click at (${coords[0]}, ${coords[1]})`;
		} else if (tool.action === "wait") {
			icon = "fa-hourglass-half";
			messageContent = "Waiting";
		} else if (tool.action === "key") {
			icon = "fa-keyboard";
			messageContent = `Key press: ${tool.text}`;
		} else if (tool.action === "type") {
			icon = "fa-keyboard";
			messageContent = "Type text";
		} else {
			icon = "fa-screwdriver-wrench";
			messageContent = "Use the system";
		}
	} else {
		icon = msg.role === "user" ? "fa-user" : "fa-robot";
		messageContent = msg.content;
	}

	return {
		isToolUse,
		isToolResult,
		icon,
		messageContent,
		role: msg.role
	};
}

async function yieldHelper(timeout)
{
	return new Promise(function(f2, r2)
	{
		setTimeout(f2, timeout);
	});
}

async function kmsSendChar(textArea, charStr)
{
	textArea.value = "_" + charStr;
	var ke = new KeyboardEvent("keydown");
	textArea.dispatchEvent(ke);
	var ke = new KeyboardEvent("keyup");
	textArea.dispatchEvent(ke);
	await yieldHelper(0);
}

function getKmsInputElement()
{
	// Find the CheerpX textare, it's attached to the body element
	for(const node of document.body.children)
	{
		if(node.tagName == "TEXTAREA")
			return node;
	}
	return null;
}

export async function handleToolImpl(tool, term)
{
	if(tool.command)
	{
		var sentinel = "# End of AI command";
		var buffer = term.buffer.active;
		// Get the current cursor position
		var marker = term.registerMarker();
		var startLine = marker.line;
		marker.dispose();
		var ret = new Promise(function(f, r)
		{
			var callbackDisposer = term.onWriteParsed(function()
			{
				var curLength = buffer.length;
				// Accumulate the output and see if the sentinel has been printed
				var output = "";
				for(var i=startLine + 1;i<curLength;i++)
				{
					var curLine = buffer.getLine(i).translateToString(true, 0, term.cols);;
					if(curLine.indexOf(sentinel) >= 0)
					{
						// We are done, cleanup and return
						callbackDisposer.dispose();
						return f(output);
					}
					output += curLine + "\n";
				}
			});
		});
		term.input(tool.command);
		term.input("\n");
		term.input(sentinel);
		term.input("\n");
		return ret;
	}
	else if(tool.action)
	{
		// Desktop control
		// TODO: We should have an explicit API to interact with CheerpX display
		switch(tool.action)
		{
			case "screenshot":
			{
				// Insert a 3 seconds delay unconditionally, the reference implementation uses 2
				await yieldHelper(3000);
				var delayCount = 0;
				var display = document.getElementById("display");
				var dc = get(displayConfig);
				if(screenshotCanvas == null)
				{
					screenshotCanvas = document.createElement("canvas");
					screenshotCtx = screenshotCanvas.getContext("2d");
				}
				if(screenshotCanvas.width != dc.width || screenshotCanvas.height != dc.height)
				{
					screenshotCanvas.width = dc.width;
					screenshotCanvas.height = dc.height;
				}
				while(1)
				{
					// Resize the canvas to a compatible size
					screenshotCtx.drawImage(display, 0, 0, display.width, display.height, 0, 0, dc.width, dc.height);
					var dataUrl = screenshotCanvas.toDataURL("image/png");
					if(dataUrl == lastScreenshot)
					{
						// Delay at most 3 times
						if(delayCount < 3)
						{
							// TODO: Defensive message, validate and remove
							console.warn("Identical screenshot, rate limiting");
							delayCount++;
							// Wait some time and retry
							await yieldHelper(5000);
							continue;
						}
					}
					lastScreenshot = dataUrl;
					// Remove prefix from the encoded data
					dataUrl = dataUrl.substring("data:image/png;base64,".length);
					var imageSrc = { type: "base64", media_type: "image/png", data: dataUrl };
					var contentObj = { type: "image", source: imageSrc };
					return [ contentObj ];
				}
			}
			case "mouse_move":
			{
				var coords = tool.coordinate;
				var dc = get(displayConfig);
				var mouseX = coords[0] / dc.mouseMult;
				var mouseY = coords[1] / dc.mouseMult;
				var display = document.getElementById("display");
				var clientRect = display.getBoundingClientRect();
				var me = new MouseEvent('mousemove', { clientX: mouseX + clientRect.left, clientY: mouseY + clientRect.top });
				display.dispatchEvent(me);
				return null;
			}
			case "left_click":
			{
				var coords = tool.coordinate;
				var dc = get(displayConfig);
				var mouseX = coords[0] / dc.mouseMult;
				var mouseY = coords[1] / dc.mouseMult;
				var display = document.getElementById("display");
				var clientRect = display.getBoundingClientRect();
				var me = new MouseEvent('mousedown', { clientX: mouseX + clientRect.left, clientY: mouseY + clientRect.top, button: 0 });
				display.dispatchEvent(me);
				// This delay prevent X11 logic from debouncing the mouseup
				await yieldHelper(60)
				me = new MouseEvent('mouseup', { clientX: mouseX + clientRect.left, clientY: mouseY + clientRect.top, button: 0 });
				display.dispatchEvent(me);
				return null;
			}
			case "right_click":
			{
				var coords = tool.coordinate;
				var dc = get(displayConfig);
				var mouseX = coords[0] / dc.mouseMult;
				var mouseY = coords[1] / dc.mouseMult;
				var display = document.getElementById("display");
				var clientRect = display.getBoundingClientRect();
				var me = new MouseEvent('mousedown', { clientX: mouseX + clientRect.left, clientY: mouseY + clientRect.top, button: 2 });
				display.dispatchEvent(me);
				// This delay prevent X11 logic from debouncing the mouseup
				await yieldHelper(60)
				me = new MouseEvent('mouseup', { clientX: mouseX + clientRect.left, clientY: mouseY + clientRect.top, button: 2 });
				display.dispatchEvent(me);
				return null;
			}
			case "type":
			{
				var str = tool.text;
				return new Promise(async function(f, r)
				{
					var textArea = getKmsInputElement();
					for(var i=0;i<str.length;i++)
					{
						await kmsSendChar(textArea, str[i]);
					}
					f(null);
				});
			}
			case "key":
			{
				var textArea = getKmsInputElement();
				var key = tool.text;
				// Support arbitrary order of modifiers
				var isCtrl = false;
				var isAlt = false;
				var isShift = false;
				while(1)
				{
					if(key.startsWith("shift+"))
					{
						isShift = true;
						key = key.substr("shift+".length);
						var ke = new KeyboardEvent("keydown", {keyCode: 0x10});
						textArea.dispatchEvent(ke);
						await yieldHelper(0);
						continue;
					}
					else if(key.startsWith("ctrl+"))
					{
						isCtrl = true;
						key = key.substr("ctrl+".length);
						var ke = new KeyboardEvent("keydown", {keyCode: 0x11});
						textArea.dispatchEvent(ke);
						await yieldHelper(0);
						continue;
					}
					else if(key.startsWith("alt+"))
					{
						isAlt = true;
						key = key.substr("alt+".length);
						var ke = new KeyboardEvent("keydown", {keyCode: 0x12});
						textArea.dispatchEvent(ke);
						await yieldHelper(0);
						continue;
					}
					break;
				}
				var ret = null;
				// Dispatch single chars directly and parse the rest
				if(key.length == 1)
				{
					await kmsSendChar(textArea, key);
				}
				else
				{
					switch(tool.text)
					{
						case "Return":
							await kmsSendChar(textArea, "\n");
							break;
						case "Escape":
							var ke = new KeyboardEvent("keydown", {keyCode: 0x1b});
							textArea.dispatchEvent(ke);
							await yieldHelper(0);
							ke = new KeyboardEvent("keyup", {keyCode: 0x1b});
							textArea.dispatchEvent(ke);
							await yieldHelper(0);
							break;
						default:
							// TODO: Support more key combinations
							ret = new Error(`Error: Invalid key '${tool.text}'`);
					}
				}
				if(isShift)
				{
					var ke = new KeyboardEvent("keyup", {keyCode: 0x10});
					textArea.dispatchEvent(ke);
					await yieldHelper(0);
				}
				if(isCtrl)
				{
					var ke = new KeyboardEvent("keyup", {keyCode: 0x11});
					textArea.dispatchEvent(ke);
					await yieldHelper(0);
				}
				if(isAlt)
				{
					var ke = new KeyboardEvent("keyup", {keyCode: 0x12});
					textArea.dispatchEvent(ke);
					await yieldHelper(0);
				}
				return ret;
			}
			case "wait":
			{
				// Wait 2x what the machine expects to compensate for virtualization slowdown
				await yieldHelper(tool.duration * 2 * 1000);
				return null;
			}
			default:
			{
				break;
			}
		}
		return new Error("Error: Invalid action");
	}
	else
	{
		// We can get there due to model hallucinations
		return new Error("Error: Invalid tool syntax");
	}
}

function initialize()
{
	var savedApiKey = localStorage.getItem("openai-api-key");
	if(savedApiKey)
		setApiKey(savedApiKey);
}

export const apiState = writable("KEY_REQUIRED");
export const messageList = writable(messages);
export const currentMessage = writable("");
export const displayConfig = writable(null);

if(browser)
	initialize();
