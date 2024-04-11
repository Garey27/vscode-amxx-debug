'use strict';

import { Socket } from 'net';
import { EventEmitter } from 'events';

export enum MessageType
{
	Diagnostics = 0,
	RequestFile,
	File,

	StartDebugging,
	StopDebugging,
	Pause,
	Continue,

	RequestCallStack,
	CallStack,

	ClearBreakpoints,
	SetBreakpoint,

	HasStopped,
	HasContinued,

	StepOver,
	StepIn,
	StepOut,

    RequestSetVariable,
    SetVariable,
	RequestVariables,
	Variables,

	RequestEvaluate,
	Evaluate,

	Disconnect,
	TotalMessages
}

export class Message
{
    type : number;
    offset : number;
    buffer : Buffer;
    size : number;
    remainingSize : number;

    constructor(type : number, offset : number, size : number, buffer : Buffer)
    {
        this.type = type;
        this.offset = offset;
        this.buffer = buffer;
        this.size = size;
    }

    readInt() : number
    {
        let value = this.buffer.readIntLE(this.offset, 4);
        this.offset += 4;
        return value;
    }

    readByte() : number
    {
        let value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        return value;
    }

    readBool() : boolean
    {
        return this.readInt() != 0;
    }

    readString() : string
    {
        let num = this.readInt();
        let ucs2 = num < 0;
        if(ucs2)
        {
            num = -num;
        }

        if(ucs2)
        {
            let str = this.buffer.toString("utf16le", this.offset, this.offset + num * 2);
            this.offset += num * 2;
            if(str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            return str;
        }
        else
        {
            let str = this.buffer.toString("utf8", this.offset, this.offset + num);
            this.offset += num;
            if(str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            return str;
        }
    }
}

function writeInt(value : number) : Buffer
{
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(value, 0);
    return newBuffer;
}

function writeString(str : string) : Buffer
{
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(str.length+1, 0);
    return Buffer.concat([newBuffer, Buffer.from(str+"\0", "binary")]);
}

let pendingBuffer : Buffer = Buffer.alloc(0);

export function readMessages(buffer : Buffer) : Array<Message>
{
    let list : Array<Message> = [];

    pendingBuffer = Buffer.concat([pendingBuffer, buffer])

    while (pendingBuffer.length >= 5)
    {
        let offset = 0;
        let msglen = pendingBuffer.readUIntLE(offset, 4);
        offset += 4;
        let msgtype = pendingBuffer.readInt8(offset);
        offset += 1;

        if (msglen <= pendingBuffer.length - offset)
        {
            list.push(new Message(msgtype, offset, msglen, pendingBuffer));
            pendingBuffer = pendingBuffer.slice(offset + msglen);
        }
        else
        {
            return list;
        }
    }

    return list;
}

// Create a connection to AMXX
let sock : Socket;
export let connected = false;
export let events = new EventEmitter();

export function connect()
{
    if (!sock)
    {
        sock = new Socket;
    }
	sock.connect(1234, "localhost", function()
	{
		console.log('Connection to hlds server established.');
        events.emit("Connected");
        connected = true;
	});

	sock.on("data", function(data : Buffer) {
		let messages : Array<Message> = readMessages(data);
		for (let msg of messages)
		{
            if (msg.type == MessageType.CallStack)
            {
                events.emit("CallStack", msg);
            }
            else if (msg.type == MessageType.HasStopped)
            {
                events.emit("Stopped", msg);
            }
            else if (msg.type == MessageType.HasContinued)
            {
                events.emit("Continued", msg);
            }
            else if (msg.type == MessageType.Variables)
            {
                events.emit("Variables", msg);
            }
            else if (msg.type == MessageType.Evaluate)
            {
                events.emit("Evaluate", msg);
            }
            else if (msg.type == MessageType.SetBreakpoint)
            {
                events.emit("SetBreakpoint", msg);
            }
            else if (msg.type == MessageType.SetVariable)
            {
                events.emit("SetVariable", msg);
            }
		}
	});

	sock.on("error", function() {
		if (sock != null)
		{
			sock.destroy();
            connected = false;
            events.emit("Closed");
		}
	});

	sock.on("close", function() {
		if (sock != null)
		{
			sock.destroy();
            connected = false;
            events.emit("Closed");
		}
	});
}

export function disconnect()
{
    sendDisconnect();
    sock.destroy();
    connected = false;
}

export function sendPause()
{
    let msg = Buffer.alloc(6);
    msg.writeUInt32LE(2, 0);
    msg.writeUInt8(MessageType.Pause, 4);
    msg.writeUInt8(2,5)

    sock.write(msg);
}

export function sendContinue()
{
    let msg = Buffer.alloc(6);
    msg.writeUInt32LE(2, 0);
    msg.writeUInt8(MessageType.Continue, 4);
    msg.writeUInt8(0,5)

    sock.write(msg);
}

export function sendRequestCallStack()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.RequestCallStack, 4);

    sock.write(msg);
}

export function sendDisconnect()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Disconnect, 4);

    sock.write(msg);
}

export function sendStartDebugging(filename)
{
    let msg = Buffer.alloc(5);
    msg.writeUInt8(MessageType.RequestFile, 4);
	msg = Buffer.concat([msg,  writeString(filename)]);

    msg.writeUInt32LE(msg.length - 4, 0);
    sock.write(msg);
}

export function sendStopDebugging()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StopDebugging, 4);

    sock.write(msg);
}

export function clearBreakpoints(pathname : string)
{
    let msg = Buffer.alloc(5);
    msg.writeUInt8(MessageType.ClearBreakpoints, 4);
    msg = Buffer.concat([msg, writeString(pathname)]);

    msg.writeUInt32LE(msg.length - 4, 0);
    sock.write(msg);
}

export function setBreakpoint(id : number, pathname : string, line : number)
{
    let head = Buffer.alloc(5);
    head.writeUInt32LE(1, 0);
    head.writeUInt8(MessageType.SetBreakpoint, 4);

    let msg = Buffer.concat([
        head, writeString(pathname), writeInt(line), writeInt(id)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    sock.write(msg);
}

export function sendStepIn()
{
    let msg = Buffer.alloc(6);
    msg.writeUInt32LE(2, 0);
    msg.writeUInt8(MessageType.StepIn, 4);
    msg.writeUInt8(3,5)

    sock.write(msg);
}

export function sendStepOver()
{
    let msg = Buffer.alloc(6);
    msg.writeUInt32LE(2, 0);
    msg.writeUInt8(MessageType.StepOver, 4);
    msg.writeUInt8(4,5)

    sock.write(msg);
}

export function sendStepOut()
{
    let msg = Buffer.alloc(6);
    msg.writeUInt32LE(5, 0);
    msg.writeUInt8(MessageType.StepOut, 4);
    msg.writeUInt8(5,5)


    sock.write(msg);
}

export function sendRequestSendVariable(variable: string, value: string, index: number)
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.RequestSetVariable, 4);

    let msg = Buffer.concat([
        head, writeString(variable), writeString(value), writeInt(index)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    sock.write(msg);
}
export function sendRequestVariables(path : string)
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.RequestVariables, 4);

    let msg = Buffer.concat([
        head, writeString(path)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    sock.write(msg);
}

export function sendRequestEvaluate(path : string, frameId : number)
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.RequestEvaluate, 4);

    let msg = Buffer.concat([
        head, writeString(path), writeInt(frameId)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    sock.write(msg);
}
