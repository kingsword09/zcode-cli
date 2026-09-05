// Diagnostic fixture: graceful FIN mid-stream (no finish_reason, no [DONE]).
// Deterministic stand-in for the racy socket.reset timing.
import { createServer } from "node:http";

function streamChunk(id, content, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "glm-5.2",
    choices: [{
      index: 0,
      delta: content ? { role: "assistant", content } : {},
      finish_reason: finishReason
    }]
  })}\n\n`;
}

let streamingRequests = 0;
const alwaysEof = process.env.ZCODE_TEST_ALWAYS_EOF === "1";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  const parsed = body ? JSON.parse(body) : {};
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  if (parsed.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-non-stream",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model: "glm-5.2",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "RECOVERED_FINAL" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
    return;
  }

  streamingRequests += 1;
  process.stdout.write(`REQUEST ${streamingRequests}\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (alwaysEof || streamingRequests === 1) {
    response.write(streamChunk("chatcmpl-truncated", "PARTIAL_SHOULD_BE_DISCARDED"));
    // HTTP ends cleanly, but the SSE protocol has no finish_reason or [DONE].
    response.end();
    return;
  }

  response.write(streamChunk("chatcmpl-recovered", "RECOVERED_FINAL"));
  response.write(streamChunk("chatcmpl-recovered", "", "stop"));
  response.end("data: [DONE]\n\n");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port.");
  process.stdout.write(`READY ${address.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
