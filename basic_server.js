/*
From book: "Build Your Own Web Server From Scratch In Node.JS"
*/


const http = require('http');
const { Buffer } = require('node:buffer');

// a parsed HTTP request header
var HTTPReq = {
    method: string,
    uri: Buffer,
    version: string,
    headers: Buffer,
};

// an HTTP response
var HTTPRes = {
    code: number,
    headers: Buffer,
    body: BodyReader,
};

// an interface for reading/writing data from/to the HTTP body.
var BodyReader = {
    // the "Content-Length", -1 if unknown.
    length: number,
    // read data. returns an empty buffer after EOF.
    read: () => Promise(Buffer)
};

async function serveClient(conn) {
    const buf = { data: Buffer.alloc(0), length: 0 };
    while (true) {
        // try to get 1 request header from the buffer
        const msg | HTTPReq = cutMessage(buf);
        if (!msg) {
            // need more data
            const data = await soRead(conn);
            bufPush(buf, data);
            // EOF?
            if (data.length === 0 && buf.length === 0) {
                return; // no more requests
            }
            if (data.length === 0) {
                throw new HTTPError(400, 'Unexpected EOF.');
            }
            // got some data, try it again.
            continue;
        }

        // process the message and send the response
        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close the connection for HTTP/1.0
        if (msg.version === '1.0') {
            return;
        }
        // make sure that the request body is consumed completely
        while ((await reqBody.read()).length > 0) { /* empty */ }
    } // loop for IO
}

async function newConn(socket) {
    const conn = soInit(socket);
    try {
        await serveClient(conn);
    } catch (exc) {
        console.error('exception:', exc);
        if (exc instanceof HTTPError) {
            // intended to send an error response
            const resp = {
                code: exc.code,
                headers: [],
                body: readerFromMemory(Buffer.from(exc.message + '\n')),
            };
            try {
                await writeHTTPResp(conn, resp);
            } catch (exc) { /* ignore */ }
        }
    } finally {
        socket.destroy();
    }
}

// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// parse & remove a header from the beginning of the buffer if possible
function cutMessage(buf): null | HTTPReq {
    // the end of the header is marked by '\r\n\r\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if (idx < 0) {
        if (buf.length >= kMaxHeaderLen) {
            throw new HTTPError(413, 'header is too large');
        }
        return null;    // need more data
    }
    // parse & remove the header
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
    bufPop(buf, idx + 4);
    return msg;
}

// parse an HTTP request header
function parseHTTPReq(data): HTTPReq {
    // split the data into lines
    const lines = splitLines(data);
    // the first line is `METHOD URI VERSION`
    const [method, uri, version] = parseRequestLine(lines[0]);
    // followed by header fields in the format of `Name: value`
    const headers = [];
    for (let i = 1; i < lines.length - 1; i++) {
        const h = Buffer.from(lines[i]);    // copy
        if (!validateHeader(h)) {
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }
    // the header ends by an empty line
    console.assert(lines[lines.length - 1].length === 0);
    return {
        method: method, uri: uri, version: version, headers: headers,
    };
}

// BodyReader from an HTTP request
function readerFromReq(
    conn, buf, req): BodyReader {
    let bodyLen = -1;
    const contentLen = fieldGet(req.headers, 'Content-Length');
    if (contentLen) {
        bodyLen = parseDec(contentLen.toString('latin1'));
        if (isNaN(bodyLen)) {
            throw new HTTPError(400, 'bad Content-Length.');
        }
    }
    const bodyAllowed = !(req.method === 'GET' || req.method === 'HEAD');
    const chunked = fieldGet(req.headers, 'Transfer-Encoding')
        ?.equals(Buffer.from('chunked')) || false;
    if (!bodyAllowed && (bodyLen > 0 || chunked)) {
        throw new HTTPError(400, 'HTTP body not allowed.');
    }
    if (!bodyAllowed) {
        bodyLen = 0;
    }

    if (bodyLen >= 0) {
        // "Content-Length" is present
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked) {
        // chunked encoding
        throw new HTTPError(501, 'TODO');
    } else {
        // read the rest of the connection
        throw new HTTPError(501, 'TODO');
    }
}

function fieldGet(headers: Buffer[], key: string): null | Buffer;

// BodyReader from a socket with a known length
function readerFromConnLength(
    conn, buf, remain): BodyReader {
    return {
        length: remain,
        read: async (): Promise<Buffer> => {
            if (remain === 0) {
                return Buffer.from(''); // done
            }
            if (buf.length === 0) {
                // try to get some data if there is none
                const data = await soRead(conn);
                bufPush(buf, data);
                if (data.length === 0) {
                    // expect more data!
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            // consume data from the buffer
            const consume = Math.min(buf.length, remain);
            remain -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume));
            bufPop(buf, consume);
            return data;
        }
    };
}

// a sample request handler
async function handleReq(req, body): Promise<HTTPRes> {
    // act on the request URI
    let resp;
    switch (req.uri.toString('latin1')) {
        case '/echo':
            // http echo server
            resp = body;
            break;
        default:
            resp = readerFromMemory(Buffer.from('hello world.\n'));
            break;
    }

    return {
        code: 200,
        headers: [Buffer.from('Server: my_first_http_server')],
        body: resp,
    };
}

// BodyReader from in-memory data
function readerFromMemory(data): BodyReader {
    let done = false;
    return {
        length: data.length,
        read: async (): Promise<Buffer> => {
            if (done) {
                return Buffer.from(''); // no more data
            } else {
                done = true;
                return data;
            }
        },
    };
}

// send an HTTP response through the socket
async function writeHTTPResp(conn, resp): Promise<void> {
    if (resp.body.length < 0) {
        throw new Error('TODO: chunked encoding');
    }
    // set the "Content-Length" field
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
    // write the header
    await soWrite(conn, encodeHTTPResp(resp));
    // write the body
    while (true) {
        const data = await resp.body.read();
        if (data.length === 0) {
            break;
        }
        await soWrite(conn, data);
    }
}

async function serveClient(conn): Promise<void> {
    const buf = { data: Buffer.alloc(0), length: 0 };
    while (true) {
        // try to get 1 request header from the buffer
        const msg: null | HTTPReq = cutMessage(buf);
        if (!msg) {
            // omitted ...
            continue;
        }

        // process the message and send the response
        const reqBody = readerFromReq(conn, buf, msg);
        const res = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close the connection for HTTP/1.0
        if (msg.version === '1.0') {
            return;
        }
        // make sure that the request body is consumed completely
        while ((await reqBody.read()).length > 0) { /* empty */ }
    } // loop for IO
}


