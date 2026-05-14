import { WebSocketServer } from "ws";
import {
  AuthStorage,
  createAgentSessionRuntime,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

const PORT = 8765;
const wss = new WebSocketServer({ port: PORT });

console.log(`[sdk-server] WebSocket server listening on ws://localhost:${PORT}`);
console.log(`[sdk-server] Open index.html in your browser to start chatting.\n`);

wss.on("connection", async (ws) => {
  console.log("[sdk-server] Browser connected — initializing agent session");

  const cwd = process.cwd();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(cwd),
  });

  // Default model to openrouter/free if not set
  try {
    const model = await modelRegistry.resolveModel("openrouter/free");
    if (model) {
      await runtime.session.setModel(model);
    }
  } catch (err) {
    console.warn("[sdk-server] Failed to set default model:", err.message);
  }

  let unsubscribe = null;

  const subscribeToSession = (session) => {
    if (unsubscribe) unsubscribe();
    unsubscribe = session.subscribe((event) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });
  };

  subscribeToSession(runtime.session);

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[sdk-server] received: ${msg.type}`);

      switch (msg.type) {
        case "prompt":
          // The SDK prompt method returns only after the full run is complete
          // We don't need to await it here if we want to process other messages (like abort)
          // but the SDK handles queueing internally.
          runtime.session.prompt(msg.message, { 
            streamingBehavior: msg.streamingBehavior,
            preflightResult: (success) => {
              if (!success && ws.readyState === ws.OPEN) {
                // Preflight failed, usually because of streaming without behavior
                ws.send(JSON.stringify({ type: "error", error: "Prompt rejected by preflight" }));
              }
            }
          }).catch(err => {
            console.error("[sdk-server] prompt error:", err);
            if (ws.readyState === ws.OPEN) {
               ws.send(JSON.stringify({ type: "error", error: err.message }));
            }
          });
          break;

        case "abort":
          await runtime.session.abort();
          break;

        case "newSession":
          await runtime.newSession();
          subscribeToSession(runtime.session);
          break;

        default:
          console.warn("[sdk-server] unknown message type:", msg.type);
      }
    } catch (err) {
      console.error("[sdk-server] failed to handle message:", err);
    }
  });

  ws.on("close", () => {
    console.log("[sdk-server] Browser disconnected — disposing session");
    if (unsubscribe) unsubscribe();
    runtime.session.dispose();
  });
});
