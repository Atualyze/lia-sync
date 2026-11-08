import { createApp } from "./src/server.mjs";
import { triggerHandoff } from "./src/handoff.mjs";
import { sendText } from "./src/whatsapp.mjs";

const app = await createApp();
console.log("HUMAN CONFIG:", app.adminConfig.active.human);

const session = {
  clientName: "Atualyze",
  phone: "5588921694598",
  history: [
    { role: "user", content: "ok, tauan" }
  ]
};

const phone = app.adminConfig.active.human?.phone;
console.log("NOTIFYING TO:", phone);

const notify = (msg) => {
  console.log("NOTIFY CALLED WITH MSG LENGTH:", msg?.length);
  return sendText(phone, msg);
};

await triggerHandoff(session, {
  reason: "teste de handoff",
  urgency: "normal",
  notify
});

console.log("HANDOFF COMPLETED. SESSION STATUS:", {
  human: session.human,
  handoffNotified: session.handoffNotified,
  handoffNotifyFailed: session.handoffNotifyFailed
});
