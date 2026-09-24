import { runTui } from "../../../packages/zcode-tui/src/index.ts";
let history = [
  { role: "user", messageId: "question-1", content: "Original question" },
  { role: "agent", messageId: "answer-1", content: "Original answer" }
];
await runTui({
  initialModel: "scenario/model", workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => history,
  readClipboardImage: async () => ({ dataUrl: "data:image/png;base64,aW1hZ2U=", mediaType: "image/png" }),
  submitPrompt: async (input) => {
    if (typeof input === "object" && input !== null && "attachments" in input) {
      if (!("text" in input) || input.text !== "Image question") throw new Error("Unexpected editor attachment sent with queued text");
      if (JSON.stringify(input.attachments) !== JSON.stringify([{ type: "image", content: "data:image/png;base64,aW1hZ2U=", mediaType: "image/png" }])) {
        throw new Error("Editor attachment was not preserved");
      }
      return { response: "Sent: Image question with original image" };
    }
    if (String(input) === "/rewind cascade conversation question-1") {
      history = [];
      return { response: "Rewound", resetSessionProjection: true, restoredMessages: [] };
    }
    return { response: `Sent: ${String(input)}` };
  }
});
