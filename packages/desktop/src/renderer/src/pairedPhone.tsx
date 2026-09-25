import { useState } from "react";
import { createRoot } from "react-dom/client";
import { connectViaWebSocket } from "@zcode/client";
import type { IServiceAccessor, SessionOwner } from "@zcode/services";
import { PairedPhoneConversation } from "@zcode/ui/paired-phone-conversation";
import "@zcode/ui/styles.css";

function App() {
  const [challenge, setChallenge] = useState("");
  const [connection, setConnection] = useState<{
    services: IServiceAccessor;
    owner: Extract<SessionOwner, { kind: "external" }>;
  } | null>(null);
  const [message, setMessage] = useState("Enter the one-use code shown on your desktop.");
  async function connect() {
    setConnection(null);
    try {
      const response = await fetch("/session", {
        method: "POST",
        headers: { "x-zcode-phone-csrf": "session-v1" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Device is not approved");
      const result = (await response.json()) as { csrf: string; owner: SessionOwner };
      if (!result.csrf || result.owner?.kind !== "external")
        throw new Error("Session owner unavailable");
      const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`;
      const services = await connectViaWebSocket(url, {
        protocols: ["zcode-phone-v1", result.csrf],
        onClose: () => {
          setConnection(null);
          setMessage("Disconnected. Reconnect to resume the same session.");
        },
      });
      setConnection({ services, owner: result.owner });
      setMessage("Connected to your existing desktop session.");
    } catch {
      setMessage("Phone authorization unavailable. Approve again on desktop or reconnect.");
    }
  }
  async function pair() {
    try {
      const response = await fetch("/pair", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", "x-zcode-phone-csrf": "pair-v1" },
        credentials: "same-origin",
        cache: "no-store",
        body: challenge,
      });
      setChallenge("");
      if (!response.ok) throw new Error("Pairing denied");
      await connect();
    } catch {
      setMessage("Pairing denied or expired. Request a new desktop code.");
    }
  }
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border p-3 text-ui-sm">
        <strong>Paired phone</strong>
        <button
          type="button"
          className="rounded-lg border border-input-border px-2 py-1"
          onClick={() => void connect()}
        >
          Reconnect
        </button>
      </header>
      <p role="status" className="px-3 py-2 text-ui-sm">
        {message}
      </p>
      {connection ? (
        <div className="min-h-0 flex-1">
          <PairedPhoneConversation services={connection.services} owner={connection.owner} />
        </div>
      ) : (
        <form
          className="flex gap-2 px-3"
          onSubmit={(event) => {
            event.preventDefault();
            void pair();
          }}
        >
          <label className="sr-only" htmlFor="code">
            Desktop one-use code
          </label>
          <input
            id="code"
            aria-label="Desktop one-use code"
            className="min-w-0 flex-1 rounded-lg border border-input-border bg-input p-2"
            value={challenge}
            autoComplete="off"
            onChange={(event) => setChallenge(event.target.value)}
          />
          <button type="submit" className="rounded-lg border border-input-border px-3">
            Pair
          </button>
        </form>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
