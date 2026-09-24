import type {
  MountedHierarchyServices,
  MountedSessionOwner,
} from "../hooks/useMountedProjectSidebar.js";
import { useMountedProjectSidebar } from "../hooks/useMountedProjectSidebar.js";
import { ProjectSidebar } from "./ProjectSidebar.js";

/** Shell mount, not a second runtime: service facts are re-read from the profile owner. */
export function MountedProjectSidebar({
  services,
  onNavigate,
  locale,
}: {
  services: MountedHierarchyServices;
  onNavigate: (owner: MountedSessionOwner) => void;
  locale: "en" | "zh";
}) {
  const { error, ...props } = useMountedProjectSidebar({ services, onNavigate, locale });
  return (
    <section
      aria-label={locale === "zh" ? "项目层级" : "Project hierarchy"}
      className="flex min-h-0 flex-col border-b border-border bg-sidebar text-ui-base"
    >
      <h2 className="shrink-0 px-3 py-2 font-medium">
        {locale === "zh" ? "项目与 Agent" : "Projects & agents"}
      </h2>
      {error ? (
        <p role="alert" className="px-3 text-ui-sm text-warning">
          {locale === "zh"
            ? "无法刷新；显示上次目录："
            : "Unable to refresh; showing last catalog: "}
          {error}
        </p>
      ) : null}
      {props.snapshot ? (
        <ProjectSidebar {...props} snapshot={props.snapshot} />
      ) : (
        <p role="status" className="px-3 pb-2 text-ui-sm text-foreground-subtle">
          {error
            ? locale === "zh"
              ? "目录不可用"
              : "Catalog unavailable"
            : locale === "zh"
              ? "加载目录…"
              : "Loading catalog…"}
        </p>
      )}
    </section>
  );
}
