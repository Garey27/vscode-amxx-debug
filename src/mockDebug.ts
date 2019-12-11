
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent,
	ContinuedEvent, Variable,
	Thread, StackFrame, Scope, Source, Handles,
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';

import * as amxx from './mockRuntime'

const { Subject } = require('await-notify');


interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	stopOnEntry?: boolean;
	trace?: boolean;
}

interface ASBreakpoint
{
	id : number;
	line : number;
}

export interface VariableContainer {
    expand(session: AmxModXDebugSession): Promise<Variable[]>;
    setValue(session: AmxModXDebugSession, name: string, value: string): Promise<string>;
}

export class Expander implements VariableContainer {

    private _expanderFunction: () => Promise<Variable[]>;

    constructor(func: () => Promise<Variable[]>) {
        this._expanderFunction = func;
    }

    async expand(session: AmxModXDebugSession): Promise<Variable[]> {
        return this._expanderFunction();
    }

    async setValue(session: AmxModXDebugSession, name: string, value: string): Promise<string> {
        throw new Error("Setting value not supported");
    }
}


export class AmxModXDebugSession extends LoggingDebugSession
{
	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private breakpoints = new Map<string, ASBreakpoint[]>();
	private nextBreakpointId = 1;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor()
	{
		super("amxx-debug");

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		amxx.events.removeAllListeners();
		amxx.events.on("CallStack", (msg : amxx.Message) => {
			this.receiveCallStack(msg);
		});

		amxx.events.on("Stopped", (msg : amxx.Message) => {
			this.receiveStopped(msg);
		});

		amxx.events.on("Continued", (msg : amxx.Message) => {
			this.receiveContinued();
		});

		amxx.events.on("Variables", (msg : amxx.Message) => {
			this.receiveVariables(msg);
		});

		amxx.events.on("Evaluate", (msg : amxx.Message) => {
			this.receiveEvaluate(msg);
		});

		amxx.events.on("BreakFilters", (msg : amxx.Message) => {
			this.receiveBreakFilters(msg);
		});

		amxx.events.on("Connected", (msg : amxx.Message) => {
			this.connected();
		});

		amxx.events.on("Closed", () => {
			this.receiveClosed();
		});

		amxx.events.on("SetBreakpoint", (msg : amxx.Message) => {
			this.receiveBreakpoint(msg);
		});


		amxx.events.on("SetVariable", (msg : amxx.Message) => {
			this.receiveSetVariable(msg);
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */

	waitingInitializeResponse : DebugProtocol.InitializeResponse;
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) : void
	{
	// build and return the capabilities of this debug adapter:
	response.body = response.body || {};

	// the adapter implements the configurationDoneRequest.
	response.body.supportsConfigurationDoneRequest = true;

	// make VS Code to use 'evaluate' when hovering over source
	response.body.supportsEvaluateForHovers = true;

	// make VS Code to show a 'step back' button
	response.body.supportsStepBack = false;

	response.body.supportsGotoTargetsRequest = true;

	// make VS Code to support data breakpoints
	response.body.supportsDataBreakpoints = false;

	// make VS Code to support completion in REPL
	response.body.supportsCompletionsRequest = false;

	// make VS Code to send cancelRequests
	response.body.supportsCancelRequest = false;

	// make VS Code send the breakpointLocations request
	response.body.supportsBreakpointLocationsRequest = true;

	response.body.supportsSetVariable = true;
	this.sendResponse(response);

	// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
	// we request them early by sending an 'initializeRequest' to the frontend.
	// The frontend will end the configuration sequence by calling 'configurationDone' request.
	this.sendEvent(new InitializedEvent());
	}

	receiveBreakFilters(msg : amxx.Message) : void
	{
		if(this.waitingInitializeResponse.body)
		{
			this.waitingInitializeResponse.body.exceptionBreakpointFilters = [];
			let count = msg.readInt();
			for (let i = 0; i < count; ++i)
			{
				let filter = msg.readString();
				let filterTitle = msg.readString();

				this.waitingInitializeResponse.body.exceptionBreakpointFilters.push(
					<DebugProtocol.ExceptionBreakpointsFilter> {
						filter: filter,
						label: filterTitle,
						default: true,
					},
				);

			}
		};

		amxx.disconnect();

		this.sendResponse(this.waitingInitializeResponse);

		// since this debug adapter can accept configuration requests like 'setASBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) : void
	{
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected connected() {
		const editor = vscode.window.activeTextEditor;
		let filename = "";
		if(editor)
		{
			filename = editor.document.fileName;
		}

		amxx.sendStartDebugging(filename);

		for (let clientPath of this.breakpoints.keys())
		{
			let breakpointList = this.getBreakpointList(clientPath);
			if (breakpointList.length != 0)
			{
				const debugPath = this.convertClientPathToDebugger(clientPath);
				amxx.clearBreakpoints(debugPath);

				for(let breakpoint of breakpointList)
				{
					amxx.setBreakpoint(breakpoint.id, debugPath, breakpoint.line);
				}
			}
		}
	}
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments)
	{
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
		amxx.connect();
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void
	{
		amxx.sendStopDebugging();
		amxx.disconnect();

		this.sendResponse(response);
	}

	protected getBreakpointList(path : string) : Array<ASBreakpoint>
	{
		let breakpointList = this.breakpoints.get(path);
		if(!breakpointList)
		{
			breakpointList = new Array<ASBreakpoint>();
			this.breakpoints.set(path, breakpointList);
		}
		return breakpointList;
	}

	waitingVariableSetRequest : Array<any>;

	protected receiveSetVariable(msg : amxx.Message)
	{
		let success = msg.readBool();
		if (this.waitingVariableSetRequest && this.waitingVariableSetRequest.length > 0)
		{
			let response = this.waitingVariableSetRequest[0].response;
			let value = this.waitingVariableSetRequest[0].value;
			this.waitingVariableSetRequest.splice(0, 1);
			response.body = {
				value: value,
				variablesReference: 0
			};
			response.success = success;
			this.sendResponse(response);
		}
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): void
	{
		const properties = this._variableHandles.get(args.variablesReference);
		let index = 0;
		let name = args.name;
		if(!properties.includes(":%global%") && !properties.includes(":%local%"))
		{
			index = parseInt(args.name);
			name = properties;
		}

		amxx.sendRequestSendVariable(name, args.value, index);

		if(!this.waitingVariableSetRequest)
			this.waitingVariableSetRequest = new Array<any>();

		this.waitingVariableSetRequest.push({
			variableRef: args.variablesReference,
			value: args.value,
			response: response,
		});

	};

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) : void
	{
		const clientLines = args.lines || [];
		const clientPath = <string>args.source.path;
		const debugPath = this.convertClientPathToDebugger(clientPath);

		let clientBreakpoints = new Array<DebugProtocol.Breakpoint>();
		let oldBreakpointList = this.getBreakpointList(clientPath);
		let breakpointList = new Array<ASBreakpoint>();

		if(amxx.connected)
			amxx.clearBreakpoints(debugPath);

		for (let line of clientLines)
		{
			let id = -1;
			for (let oldBP of oldBreakpointList)
			{
				if (oldBP.line == line)
					id = oldBP.id;
			}

			if (id == -1)
				id = this.nextBreakpointId++;

			let clientBreak = <DebugProtocol.Breakpoint> {
				id: id,
				verified: true,
				line: line
			}
			clientBreakpoints.push(clientBreak);

			let breakpoint = <ASBreakpoint> { id: clientBreak.id, line: line };
			breakpointList.push(breakpoint);

			if(amxx.connected)
				amxx.setBreakpoint(breakpoint.id, debugPath, line);
		}

		this.breakpoints.set(clientPath, breakpointList);

		response.body = {
			breakpoints: clientBreakpoints
		};
		this.sendResponse(response);
	}

	protected receiveBreakpoint(msg : amxx.Message)
	{
		let filename = msg.readString();
		let line = msg.readInt();
		let id = msg.readInt();

		let breakpointList = this.getBreakpointList(filename);

		// If our line number has changed, but we are overlapping an existing breakpoint,
		// we should delete the new breakpoint.
		let overlapsExistingBreakpoint = false;
		for (let i = 0; i < breakpointList.length; ++i)
		{
			let bp = breakpointList[i];
			if (bp.id != id && bp.line == line)
			{
				overlapsExistingBreakpoint = true;
				break;
			}
		}

		// For some reason, doing multiple sendEvent calls at once
		// confuses visual studio code (?). So we spread them out
		// by a few ms so it can deal with it.
		let timeout = 1;

		let adapter = this;
		for (let i = 0; i < breakpointList.length; ++i)
		{
			let bp = breakpointList[i];
			if (bp.id == id)
			{
				if (overlapsExistingBreakpoint)
				{
					// We created a breakpoint that was moved to a line that already has a breakpoint,
					// so just remove the one we created.
					breakpointList.splice(i, 1);
					setTimeout(function()
					{
						adapter.sendEvent(new BreakpointEvent('removed', <DebugProtocol.Breakpoint>{ verified: false, id: bp.id }));
					}, timeout++);
				}
				else if (line == -1)
				{
					// No code existed at this line, so show it as an unverified breakpoint
					breakpointList.splice(i, 1);
					setTimeout(function()
					{
						adapter.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: false, id: bp.id, line: bp.line }));
					}, timeout++);
				}
				else
				{
					// The breakpoint was moved to a different line that actually has code on it, send a change back to the UI
					bp.line = line;
					setTimeout(function()
					{
						adapter.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: true, id: bp.id, line: bp.line }));
					}, timeout++);
				}

				break;
			}
		}

		this.breakpoints.set(filename, breakpointList);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void
	{
		// runtime supports now threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(AmxModXDebugSession.THREAD_ID, "Amxx Editor")
			]
		};
		this.sendResponse(response);
	}


	waitingTraces : Array<DebugProtocol.StackTraceResponse>;

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) : void
	{
		amxx.sendRequestCallStack();

		if(!this.waitingTraces)
			this.waitingTraces = new Array<DebugProtocol.StackTraceResponse>();

		this.waitingTraces.push(response);
	}

	protected receiveCallStack(msg : amxx.Message)
	{
		let stack = new Array<StackFrame>();

		let count = msg.readInt();
		for(let i = 0; i < count; ++i)
		{
			let name = msg.readString().replace(/_Implementation$/, "");
			let source = this.createSource(msg.readString());
			let line = msg.readInt();

			let frame = new StackFrame(i, name, source, line, 1);
			stack.push(frame);
		}

		if(stack.length == 0)
		{
			stack.push(new StackFrame(0, "No CallStack", this.createSource(""), 1));
		}

		if (this.waitingTraces && this.waitingTraces.length > 0)
		{
			let response = this.waitingTraces[0];
			this.waitingTraces.splice(0, 1);

			response.body = {
				stackFrames: stack,
				totalFrames: stack.length,
			};

			this.sendResponse(response);
		}
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) : void
	{
		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Locals", this._variableHandles.create(frameReference+":%local%"), false));
		scopes.push(new Scope("Globals", this._variableHandles.create(frameReference+":%global%"), false));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	waitingVariableRequests : Array<any>;

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) : void
	{
		const id = this._variableHandles.get(args.variablesReference);
		amxx.sendRequestVariables(id);

		if(!this.waitingVariableRequests)
			this.waitingVariableRequests = new Array<any>();

		this.waitingVariableRequests.push({
			response: response,
			id: id,
		});
	}

	combineExpression(expr : string, variable : string) : string
	{
		if(variable.startsWith("[") && variable.endsWith("]"))
			return expr + variable;

		return expr + "." + variable;
	}

	protected receiveVariables(msg : amxx.Message)
	{
		let id = "";
		if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0)
		{
			id = this.waitingVariableRequests[0].id;
		}

		let variables = new Array<DebugProtocol.Variable>();

		let count = msg.readInt();
		for(let i = 0; i < count; ++i)
		{
			let name = msg.readString();
			let value = msg.readString();
			let type = msg.readString();
			msg.readBool();

			let evalName = this.combineExpression(id, name);
			let variable:DebugProtocol.Variable = {
				name: name,
				type: type,
				value: value,
				variablesReference: 0,
				evaluateName: evalName,
			};
			if(type == "Array")
			{
				let array = value.split(',')
				variable.value = "";
				variable.namedVariables = 0;
				variable.indexedVariables = array.length;
				variable.variablesReference = this._variableHandles.create(name);
			}

			variables.push(variable);
		}

		if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0)
		{
			let response = this.waitingVariableRequests[0].response;
			this.waitingVariableRequests.splice(0, 1);

			response.body = {
				variables: variables,
			};

			this.sendResponse(response);
		}
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) : void
	{
		amxx.sendContinue();
		this.sendResponse(response);
	}

	protected receiveContinued()
	{
		this.sendEvent(new ContinuedEvent(AmxModXDebugSession.THREAD_ID));
	}

	protected receiveClosed()
	{
		this.sendEvent(new TerminatedEvent());
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void
	{
		amxx.sendPause();
		this.sendResponse(response);
	}

	previousException : string;
	protected receiveStopped(msg : amxx.Message)
	{
		let Reason = msg.readString();
		let Description = msg.readString();
		let Text = msg.readString();

		if(Text.length != 0 && Reason == 'exception')
		{
			this.previousException = Text;
			this.sendEvent(new StoppedEvent(Reason, AmxModXDebugSession.THREAD_ID, Text));
		}
		else
		{
			this.previousException = "";
			this.sendEvent(new StoppedEvent(Reason, AmxModXDebugSession.THREAD_ID));
		}
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments): void
	{
		if(!this.previousException)
		{
			this.sendResponse(response);
			return;
		}

		response.body = {
			exceptionId: "",
			breakMode: "unhandled",
			description: this.previousException,
		};
		this.sendResponse(response);
	}

		protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) : void
		{
		amxx.sendStepOver();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void
	{
		amxx.sendStepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void
	{
		amxx.sendStepOut();
		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void
	{
		this.sendResponse(response);
	}

	waitingEvaluateRequests : Array<any>;
		protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) : void
		{
		amxx.sendRequestEvaluate(args.expression, args.frameId?args.frameId:0);

		if(!this.waitingEvaluateRequests)
			this.waitingEvaluateRequests = new Array<any>();

		this.waitingEvaluateRequests.push({
			expression: args.expression,
			frameId: args.frameId,
			response: response,
		});
	}

	protected receiveEvaluate(msg : amxx.Message)
	{
		let id = "";
		if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0)
		{
			id = this.waitingEvaluateRequests[0].expression;
			if(!/^[0-9]+:/.test(id))
			{
				id = this.waitingEvaluateRequests[0].frameId + ":" + id;
			}
		}

		let name = msg.readString();
		let value = msg.readString();
		let type = msg.readString();
		let bHasMembers = msg.readBool();

		if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0)
		{
			let response = this.waitingEvaluateRequests[0].response;
			this.waitingEvaluateRequests.splice(0, 1);

			if(value.length == 0)
			{

			}
			else
			{
				response.body = {
					result: value,
					variablesReference: bHasMembers ? this._variableHandles.create(id) : 0,
				};
			}
			this.sendResponse(response);
		}
	}

	//---- helpers
	private createSource(filePath: string): Source
	{
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'as-adapter-data');
	}
}
