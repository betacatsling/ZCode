import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@zcode/ui";
import "@zcode/ui/styles.css";

function FoundationFixture() {
  const [draft, setDraft] = React.useState("");
  const [updates, setUpdates] = React.useState(0);

  return (
    <main className="bg-background text-foreground min-h-screen p-4 text-ui-base">
      <label htmlFor="draft">Fixture draft</label>
      <textarea
        id="draft"
        className="block w-full max-w-xl rounded-lg border border-input-border bg-input p-2 text-mobile-input-safe md:text-ui-base"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="button" onClick={() => setUpdates((value) => value + 1)}>
        Fixture update
      </Button>
      <output data-testid="fixture-updates">{updates}</output>
      <button
        type="button"
        hidden
        data-testid="fixture-external-update"
        onClick={() => setUpdates((value) => value + 1)}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<FoundationFixture />);
