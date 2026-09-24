import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import type { SidebarActions } from "./types.js";

export function ProjectImportDialog({
  onImport,
  locale,
  onClose,
}: {
  onImport: NonNullable<SidebarActions["onImportProject"]>;
  locale: "en" | "zh";
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    try {
      // 修复从路径猜本机目标的误绑定：目标标识显式交给 Catalog 校验，失败保持原输入。
      await onImport({
        name: String(data.get("name")),
        targetId: String(data.get("target")),
        repositoryPath: String(data.get("path")),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{locale === "zh" ? "导入项目" : "Import project"}</DialogTitle>
          <DialogDescription>
            {locale === "zh"
              ? "目标必须已受信；目录由目标端验证，不按路径推断身份。"
              : "Use a trusted target ID. The target verifies Git; a path is not an identity."}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-2" onSubmit={submit}>
          {(
            [
              ["name", locale === "zh" ? "项目名" : "Project name"],
              ["target", locale === "zh" ? "受信目标 ID" : "Trusted target ID"],
              ["path", locale === "zh" ? "仓库目录" : "Repository path"],
            ] as const
          ).map(([name, label]) => (
            <label key={name} className="block text-ui-sm text-foreground-subtle">
              {label}
              <Input required name={name} aria-label={label} />
            </label>
          ))}
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {locale === "zh" ? "取消" : "Cancel"}
            </Button>
            <Button type="submit" disabled={pending}>
              {locale === "zh" ? "导入" : "Import"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
