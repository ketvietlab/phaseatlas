<script lang="ts">
  import type { CanonicalTask, TaskDependency, TaskState } from "@phaseatlas/contracts";

  export let tasks: CanonicalTask[] = [];
  export let selectedTaskKey = "";
  export let initializingTaskKeys: string[] = [];
  export let onSelect: (task: CanonicalTask) => void = () => undefined;
  export let onOpenDetails: (task: CanonicalTask) => void = () => undefined;

  const STANDARD_LAYOUT = { nodeWidth: 184, nodeHeight: 104, columnGap: 64, rowGap: 12, padding: 36 };
  const DENSE_LAYOUT = { nodeWidth: 152, nodeHeight: 76, columnGap: 80, rowGap: 8, padding: 24 };
  const DENSE_TASK_THRESHOLD = 60;
  const BLOCKING_RELATIONS = new Set<TaskDependency["relation"]>([
    "blocks_start",
    "blocks_completion",
    "requires_contract",
    "requires_evidence",
  ]);
  const STATE_RANK: Partial<Record<TaskState, number>> = {
    draft: 0,
    planned: 1,
    ready: 2,
    in_progress: 3,
    in_review: 4,
    done: 5,
  };

  type MapTone = "done" | "active" | "review" | "ready" | "blocked" | "waiting" | "pending" | "paused" | "cancelled";

  interface MapNode {
    key: string;
    task: CanonicalTask;
    x: number;
    y: number;
    width: number;
    height: number;
    tone: MapTone;
    label: string;
    blockedBy: string[];
  }

  interface MapEdge {
    key: string;
    source: MapNode;
    target: MapNode;
    relation: TaskDependency["relation"];
    blocked: boolean;
    complete: boolean;
    routeLane?: number;
  }

  interface TaskMapModel {
    nodes: MapNode[];
    edges: MapEdge[];
    width: number;
    height: number;
    viewportHeight: number;
    density: "standard" | "dense";
    summary: { done: number; active: number; blocked: number; remaining: number };
  }

  let mapViewport: HTMLDivElement;
  let panPointerId = -1;
  let panStartX = 0;
  let panStartY = 0;
  let panStartLeft = 0;
  let panStartTop = 0;
  let panMoved = false;
  let panning = false;
  let suppressPointerClickUntil = 0;

  function taskKey(task: CanonicalTask): string {
    return `${task.key.workspaceSlug}/${task.key.taskId}`;
  }

  function dependencySatisfied(task: CanonicalTask, requiredState: TaskState | undefined): boolean {
    const expected = requiredState ?? "done";
    const actualRank = STATE_RANK[task.state];
    const expectedRank = STATE_RANK[expected];
    if (actualRank !== undefined && expectedRank !== undefined) return actualRank >= expectedRank;
    return task.state === expected;
  }

  function presentation(task: CanonicalTask, byKey: Map<string, CanonicalTask>): Pick<MapNode, "tone" | "label" | "blockedBy"> {
    const blockedBy = task.dependencies
      .filter((dependency) => BLOCKING_RELATIONS.has(dependency.relation))
      .filter((dependency) => {
        const dependencyTask = byKey.get(dependency.taskKey);
        return !dependencyTask || !dependencySatisfied(dependencyTask, dependency.requiredState);
      })
      .map((dependency) => byKey.get(dependency.taskKey)?.key.taskId ?? dependency.taskKey);

    if (task.state === "done") return { tone: "done", label: "Done", blockedBy: [] };
    if (task.state === "blocked") return { tone: "blocked", label: "Blocked", blockedBy };
    if (task.state === "in_progress") return { tone: "active", label: "In progress", blockedBy };
    if (task.state === "in_review") return { tone: "review", label: "In review", blockedBy };
    if (blockedBy.length) return { tone: "waiting", label: "Waiting", blockedBy };
    if (task.state === "ready") return { tone: "ready", label: "Ready", blockedBy: [] };
    if (task.state === "deferred") return { tone: "paused", label: "Deferred", blockedBy: [] };
    if (task.state === "cancelled") return { tone: "cancelled", label: "Cancelled", blockedBy: [] };
    return { tone: "pending", label: "Not started", blockedBy: [] };
  }

  function buildMap(currentTasks: CanonicalTask[]): TaskMapModel {
    const density = currentTasks.length >= DENSE_TASK_THRESHOLD ? "dense" : "standard";
    const layout = density === "dense" ? DENSE_LAYOUT : STANDARD_LAYOUT;
    const byKey = new Map(currentTasks.map((task) => [taskKey(task), task]));
    const depthCache = new Map<string, number>();

    function depthFor(task: CanonicalTask, trail = new Set<string>()): number {
      const key = taskKey(task);
      const cached = depthCache.get(key);
      if (cached !== undefined) return cached;
      if (trail.has(key)) return 0;
      const nextTrail = new Set(trail).add(key);
      const dependencies = task.dependencies
        .filter((dependency) => BLOCKING_RELATIONS.has(dependency.relation))
        .map((dependency) => byKey.get(dependency.taskKey))
        .filter((dependency): dependency is CanonicalTask => Boolean(dependency));
      const depth = dependencies.length
        ? Math.max(...dependencies.map((dependency) => depthFor(dependency, nextTrail) + 1))
        : 0;
      depthCache.set(key, depth);
      return depth;
    }

    const columns = new Map<number, CanonicalTask[]>();
    for (const task of currentTasks) {
      const depth = depthFor(task);
      columns.set(depth, [...(columns.get(depth) ?? []), task]);
    }
    for (const columnTasks of columns.values()) {
      columnTasks.sort((left, right) => left.key.taskId.localeCompare(right.key.taskId));
    }

    const columnCount = Math.max(...columns.keys(), 0) + 1;
    const largestColumn = Math.max(...[...columns.values()].map((column) => column.length), 1);
    const rowPitch = layout.nodeHeight + layout.rowGap;
    const mapHeight = layout.padding * 2 + largestColumn * layout.nodeHeight + (largestColumn - 1) * layout.rowGap;
    const nodes: MapNode[] = [];

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const columnTasks = columns.get(columnIndex) ?? [];
      const columnHeight = columnTasks.length * layout.nodeHeight + Math.max(columnTasks.length - 1, 0) * layout.rowGap;
      const topOffset = layout.padding + Math.max((mapHeight - layout.padding * 2 - columnHeight) / 2, 0);
      columnTasks.forEach((task, rowIndex) => {
        nodes.push({
          key: taskKey(task),
          task,
          x: layout.padding + columnIndex * (layout.nodeWidth + layout.columnGap),
          y: topOffset + rowIndex * rowPitch,
          width: layout.nodeWidth,
          height: layout.nodeHeight,
          ...presentation(task, byKey),
        });
      });
    }

    const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
    const edges: MapEdge[] = [];
    let longRouteLane = 0;
    for (const target of nodes) {
      for (const dependency of target.task.dependencies.filter((item) => BLOCKING_RELATIONS.has(item.relation))) {
        const source = nodeByKey.get(dependency.taskKey);
        if (!source) continue;
        const spansMultipleColumns = target.x - source.x > layout.nodeWidth + layout.columnGap + 1;
        edges.push({
          key: `${source.key}->${target.key}:${dependency.relation}`,
          source,
          target,
          relation: dependency.relation,
          blocked: target.blockedBy.includes(source.task.key.taskId),
          complete: source.task.state === "done",
          ...(spansMultipleColumns ? { routeLane: longRouteLane++ } : {}),
        });
      }
    }

    const summary = {
      done: nodes.filter((node) => node.tone === "done").length,
      active: nodes.filter((node) => node.tone === "active" || node.tone === "review").length,
      blocked: nodes.filter((node) => node.tone === "blocked" || node.tone === "waiting").length,
      remaining: nodes.filter((node) => !["done", "active", "review", "blocked", "waiting"].includes(node.tone)).length,
    };

    return {
      nodes,
      edges,
      width: layout.padding * 2 + columnCount * layout.nodeWidth + Math.max(columnCount - 1, 0) * layout.columnGap,
      height: mapHeight,
      viewportHeight: Math.min(Math.max(mapHeight, 420), 1000),
      density,
      summary,
    };
  }

  function edgePath(edge: MapEdge): string {
    const startX = edge.source.x + edge.source.width;
    const startY = edge.source.y + edge.source.height / 2;
    const endX = edge.target.x;
    const endY = edge.target.y + edge.target.height / 2;
    if (edge.routeLane !== undefined) {
      const availableGap = Math.max(endX - startX, 44);
      const routeInset = Math.max(Math.min(availableGap * 0.16, 28), 18);
      const exitX = startX + routeInset;
      const entryX = endX - routeInset;
      const laneY = 12 + (edge.routeLane % 4) * 8;
      const curveReach = Math.min(availableGap * 0.28, 40);
      const laneLead = 24;
      return [
        `M ${startX} ${startY}`,
        `C ${startX + curveReach} ${startY}, ${exitX} ${laneY}, ${exitX + laneLead} ${laneY}`,
        `H ${entryX - laneLead}`,
        `C ${entryX} ${laneY}, ${endX - curveReach} ${endY}, ${endX} ${endY}`,
      ].join(" ");
    }
    const bendX = startX + (endX - startX) * 0.5;
    return `M ${startX} ${startY} C ${bendX} ${startY}, ${bendX} ${endY}, ${endX} ${endY}`;
  }

  function beginPan(event: PointerEvent): void {
    if (event.button !== 0 || panPointerId !== -1) return;
    const viewport = event.currentTarget as HTMLDivElement;
    panPointerId = event.pointerId;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panStartLeft = viewport.scrollLeft;
    panStartTop = viewport.scrollTop;
    panMoved = false;
  }

  function movePan(event: PointerEvent): void {
    if (event.pointerId !== panPointerId) return;
    const deltaX = event.clientX - panStartX;
    const deltaY = event.clientY - panStartY;
    if (!panMoved && Math.hypot(deltaX, deltaY) < 4) return;
    panMoved = true;
    panning = true;
    event.preventDefault();
    mapViewport.scrollLeft = panStartLeft - deltaX;
    mapViewport.scrollTop = panStartTop - deltaY;
  }

  function endPan(event: PointerEvent): void {
    if (event.pointerId !== panPointerId) return;
    if (panMoved) suppressPointerClickUntil = Date.now() + 180;
    panPointerId = -1;
    panning = false;
  }

  function selectNode(event: MouseEvent, node: MapNode): void {
    if (event.detail > 0 && Date.now() < suppressPointerClickUntil) {
      event.preventDefault();
      return;
    }
    onSelect(node.task);
  }

  function navigateMap(event: KeyboardEvent): void {
    const distance = event.shiftKey ? 240 : 88;
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-distance, 0],
      ArrowRight: [distance, 0],
      ArrowUp: [0, -distance],
      ArrowDown: [0, distance],
    };
    if (event.key === "Home") {
      event.preventDefault();
      mapViewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
      return;
    }
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    mapViewport.scrollBy({ left: offset[0], top: offset[1], behavior: "smooth" });
  }

  function mapInteractions(node: HTMLDivElement): { destroy: () => void } {
    node.tabIndex = 0;
    node.addEventListener("pointerdown", beginPan);
    node.addEventListener("keydown", navigateMap);
    return {
      destroy: () => {
        node.removeEventListener("pointerdown", beginPan);
        node.removeEventListener("keydown", navigateMap);
      },
    };
  }

  $: model = buildMap(tasks);
  $: initializingKeys = new Set(initializingTaskKeys);
  $: selectedNode = model.nodes.find((node) => node.key === selectedTaskKey);
  $: attention = model.nodes.filter((node) => ["blocked", "waiting", "review"].includes(node.tone));
</script>

<svelte:window onpointermove={movePan} onpointerup={endPan} onpointercancel={endPan} />

<section class:dense={model.density === "dense"} class="task-map-shell" aria-label="Task dependency map">
  <header class="map-header">
    <div>
      <p class="map-eyebrow">Dependency atlas</p>
      <h2>Task map</h2>
      <p>Read delivery from left to right. Drag the canvas to pan through large workspaces.</p>
    </div>
    <div class="map-summary" aria-label="Task status summary">
      <span data-tone="done"><strong>{model.summary.done}</strong>Done</span>
      <span data-tone="active"><strong>{model.summary.active}</strong>Active</span>
      <span data-tone="blocked"><strong>{model.summary.blocked}</strong>Blocked</span>
      <span data-tone="pending"><strong>{model.summary.remaining}</strong>Remaining</span>
    </div>
  </header>

  <div class="map-legend" aria-label="Map legend">
    <span data-tone="done"><i></i>Done</span>
    <span data-tone="active"><i></i>In progress</span>
    <span data-tone="ready"><i></i>Ready</span>
    <span data-tone="waiting"><i></i>Waiting on dependency</span>
    <span data-tone="pending"><i></i>Not started</span>
    <span class="map-pan-hint"><strong>{model.nodes.length}</strong> tasks · Drag or use arrow keys to pan{model.density === "dense" ? " · Dense view" : ""}</span>
  </div>

  {#if model.nodes.length}
    <div
      bind:this={mapViewport}
      class:panning
      class="map-scroll"
      style:height={`${model.viewportHeight}px`}
      role="region"
      aria-label={`Scrollable dependency map with ${model.nodes.length} tasks`}
      aria-roledescription="draggable dependency map"
      use:mapInteractions
    >
      <div class="dependency-canvas" style:width={`${model.width}px`} style:height={`${model.height}px`}>
        <svg class="edge-layer" viewBox={`0 0 ${model.width} ${model.height}`} aria-hidden="true">
          <defs>
            <marker id="task-map-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>
          {#each model.edges as edge (edge.key)}
            <path
              class:blocked={edge.blocked}
              class:complete={edge.complete}
              class="task-edge"
              d={edgePath(edge)}
              marker-end="url(#task-map-arrow)"
            />
          {/each}
        </svg>

        {#each model.nodes as node (node.key)}
          <button
            type="button"
            class="task-node"
            class:selected={node.key === selectedTaskKey}
            data-tone={node.tone}
            style:left={`${node.x}px`}
            style:top={`${node.y}px`}
            style:width={`${node.width}px`}
            style:height={`${node.height}px`}
            aria-pressed={node.key === selectedTaskKey}
            aria-label={`${node.task.key.taskId}, ${node.task.title}, ${node.label}`}
            onclick={(event) => selectNode(event, node)}
          >
            <span class="node-topline">
              <span class="node-id">{node.task.key.taskId}</span>
              <span class="node-state"><i></i>{node.label}</span>
            </span>
            <strong>{node.task.title}</strong>
            <span class="node-meta">{node.task.phaseId.replaceAll("-", " ")} · {node.task.priority}</span>
            <span class="node-foot">
              {#if initializingKeys.has(node.key)}
                <span class="body-initializing"><i class="content-spinner" aria-hidden="true"></i>Initializing body</span>
              {:else if node.blockedBy.length}
                <span class="blocked-by">Waiting for {node.blockedBy.join(", ")}</span>
              {:else if node.task.content}
                <span class="body-ready">Body initialized</span>
              {:else}
                <span>Outline only</span>
              {/if}
              <span>{node.task.dependencies.length} dep{node.task.dependencies.length === 1 ? "" : "s"}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <div class="map-empty"><strong>No tasks to map</strong><span>Publish canonical tasks to build the dependency atlas.</span></div>
  {/if}

  <div class="map-lower-grid">
    <aside class="attention-panel">
      <header><div><p class="map-eyebrow">Attention</p><h3>{attention.length} task{attention.length === 1 ? "" : "s"} need attention</h3></div><span>!</span></header>
      {#if attention.length}
        <div class="attention-items">
          {#each attention.slice(0, 5) as node, index}
            <button type="button" class:initializing={initializingKeys.has(node.key)} aria-busy={initializingKeys.has(node.key)} onclick={() => onSelect(node.task)}>
              <span>{#if initializingKeys.has(node.key)}<i class="content-spinner" role="status" aria-label="Initializing task content"></i>{:else}{String(index + 1).padStart(2, "0")}{/if}</span>
              <span><strong>{node.task.key.taskId} · {node.label}</strong><small>{initializingKeys.has(node.key) ? "Initializing task content…" : node.blockedBy.length ? `Waiting for ${node.blockedBy.join(", ")}` : node.task.title}</small></span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="attention-empty">No blockers or reviews need attention.</p>
      {/if}
    </aside>

    <aside class="selection-panel">
      {#if selectedNode}
        <div>
          <p class="map-eyebrow">Selected task</p>
          <span class="selected-identity"><strong>{selectedNode.task.key.taskId}</strong><span data-tone={selectedNode.tone}>{selectedNode.label}</span></span>
          <h3>{selectedNode.task.title}</h3>
          <p>{selectedNode.task.objective}</p>
        </div>
        <button type="button" onclick={() => onOpenDetails(selectedNode.task)}>Open full details <span aria-hidden="true">→</span></button>
      {:else}
        <div class="selection-empty"><p class="map-eyebrow">Selected task</p><h3>Choose a node</h3><p>Inspect its objective and jump into the full task workbench.</p></div>
      {/if}
    </aside>
  </div>
</section>

<style>
  .task-map-shell { --map-blocked-surface: color-mix(in srgb,#c44242 15%,var(--surface)); --map-blocked-border: color-mix(in srgb,#c44242 78%,var(--border)); --map-blocked-text: color-mix(in srgb,#c44242 62%,var(--text)); --map-blocked-dot: color-mix(in srgb,#c44242 78%,var(--text)); --map-waiting-surface: color-mix(in srgb,var(--warning-500) 14%,var(--surface)); --map-waiting-border: color-mix(in srgb,var(--warning-500) 82%,var(--border)); --map-waiting-text: color-mix(in srgb,var(--warning-500) 58%,var(--text)); --map-waiting-dot: color-mix(in srgb,var(--warning-500) 74%,var(--text)); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-card); }
  .map-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 28px; border-bottom: 1px solid var(--border); padding: 22px 24px 18px; }
  .map-eyebrow { margin: 0 0 3px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  .map-header h2 { margin: 0; font-size: 22px; letter-spacing: -.025em; }
  .map-header > div:first-child > p:last-child { max-width: 620px; margin: 6px 0 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
  .map-summary { display: grid; flex: 0 0 auto; grid-template-columns: repeat(4, minmax(64px, 1fr)); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-soft); }
  .map-summary > span { min-width: 72px; padding: 10px 12px; color: var(--text-subtle); font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .map-summary > span + span { border-left: 1px solid var(--border); }
  .map-summary strong { display: block; margin-bottom: 2px; color: var(--text); font-size: 18px; font-variant-numeric: tabular-nums; letter-spacing: -.03em; }
  .map-summary [data-tone="done"] strong { color: var(--success-text); }.map-summary [data-tone="blocked"] strong { color: var(--map-blocked-text); }.map-summary [data-tone="active"] strong { color: var(--active-text); }
  .map-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; border-bottom: 1px solid var(--border-soft); padding: 10px 24px; color: var(--text-muted); font-size: 11px; }
  .map-legend span { display: inline-flex; align-items: center; gap: 6px; }.map-legend i { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-400); }
  .map-legend [data-tone="done"] i { background: var(--success-500); }.map-legend [data-tone="active"] i { background: var(--brand-500); }.map-legend [data-tone="ready"] i { box-shadow: inset 0 0 0 2px var(--brand-500); background: transparent; }.map-legend [data-tone="waiting"] i { box-shadow: 0 0 0 2px color-mix(in srgb,var(--map-waiting-dot) 20%,transparent); background: var(--map-waiting-dot); }
  .map-pan-hint { margin-left: auto; border-left: 1px solid var(--border); padding-left: 14px; color: var(--text-subtle); font: 10px/1.3 "SFMono-Regular",Consolas,monospace; }.map-pan-hint strong { color: var(--active-text); font-size: 11px; }
  .map-scroll { position: relative; max-width: 100%; overflow: auto; border-bottom: 1px solid var(--border); outline: none; background-color: var(--canvas); background-image: linear-gradient(var(--border-soft) 1px, transparent 1px), linear-gradient(90deg, var(--border-soft) 1px, transparent 1px); background-size: 24px 24px; cursor: grab; overscroll-behavior: contain; scrollbar-color: var(--border) transparent; scrollbar-width: thin; touch-action: none; }
  .map-scroll:focus-visible { box-shadow: inset 0 0 0 3px color-mix(in srgb,var(--brand-300) 48%,transparent); }.map-scroll.panning { cursor: grabbing; scroll-behavior: auto; user-select: none; }
  .dependency-canvas { position: relative; min-height: 300px; margin: 0 auto; }
  .edge-layer { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }.edge-layer marker path { fill: var(--brand-400); }
  .task-edge { fill: none; stroke: var(--brand-300); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.15; vector-effect: non-scaling-stroke; transition: opacity .16s ease, stroke .16s ease; }.task-edge.blocked { stroke: var(--map-blocked-dot); stroke-dasharray: 8 7; }.task-edge.complete { stroke: var(--success-500); }
  .task-node { position: absolute; z-index: 1; display: grid; grid-template-rows: auto minmax(28px, auto) auto 1fr; align-content: start; gap: 4px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); padding: 9px 10px 8px; background: color-mix(in srgb, var(--surface) 97%, transparent); color: var(--text); box-shadow: var(--shadow-card); text-align: left; transition: border-color .16s ease, box-shadow .16s ease, opacity .16s ease, transform .16s ease; backdrop-filter: blur(8px); cursor: pointer; }
  .task-node:hover { z-index: 3; border-color: var(--brand-300); box-shadow: var(--shadow-hover); transform: translateY(-1px); }.task-node.selected { z-index: 2; border-color: var(--brand-500); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-300) 30%, transparent), var(--shadow-hover); }
  .task-node[data-tone="done"] { border-color: color-mix(in srgb, var(--success-500) 65%, var(--border)); background: var(--success-surface); }.task-node[data-tone="blocked"] { border-color: var(--map-blocked-border); background: var(--map-blocked-surface); }.task-node[data-tone="waiting"] { border-color: var(--map-waiting-border); background: var(--map-waiting-surface); }.task-node[data-tone="active"],.task-node[data-tone="review"] { border-color: color-mix(in srgb, var(--brand-500) 70%, var(--border)); background: var(--active-surface); }.task-node[data-tone="ready"] { border-color: var(--brand-300); }
  .node-topline,.node-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }.node-id { display: inline-grid; min-width: 48px; height: 20px; place-items: center; border-radius: var(--radius-xs); padding: 0 5px; background: var(--surface-raised); color: var(--active-text); font: 800 9px/1 "SFMono-Regular",Consolas,monospace; letter-spacing: .03em; }.node-state { display: inline-flex; min-width: 0; align-items: center; gap: 4px; overflow: hidden; color: var(--text-muted); font-size: 9px; font-weight: 750; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }.node-state i { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--ink-400); }.task-node[data-tone="done"] .node-state i { background: var(--success-500); }.task-node[data-tone="active"] .node-state i,.task-node[data-tone="review"] .node-state i,.task-node[data-tone="ready"] .node-state i { background: var(--brand-500); }.task-node[data-tone="blocked"] .node-state { color: var(--map-blocked-text); }.task-node[data-tone="blocked"] .node-state i { box-shadow: 0 0 0 3px color-mix(in srgb,var(--map-blocked-dot) 18%,transparent); background: var(--map-blocked-dot); }.task-node[data-tone="blocked"] .node-id { color: var(--map-blocked-text); }.task-node[data-tone="waiting"] .node-state { color: var(--map-waiting-text); }.task-node[data-tone="waiting"] .node-state i { box-shadow: 0 0 0 3px color-mix(in srgb,var(--map-waiting-dot) 18%,transparent); background: var(--map-waiting-dot); }.task-node[data-tone="waiting"] .node-id { color: var(--map-waiting-text); }
  .task-node > strong { display: -webkit-box; overflow: hidden; font-size: 12px; font-weight: 750; line-height: 1.28; line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }.node-meta { overflow: hidden; color: var(--text-subtle); font-size: 9px; text-overflow: ellipsis; text-transform: capitalize; white-space: nowrap; }.node-foot { align-self: end; border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent); padding-top: 4px; color: var(--text-subtle); font-size: 9px; }.node-foot > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.node-foot > span:first-child { min-width: 0; }.node-foot > span:last-child { flex: 0 0 auto; }.blocked-by { color: var(--warning-600); font-weight: 700; }.task-node[data-tone="blocked"] .blocked-by { color: var(--map-blocked-text); }.task-node[data-tone="waiting"] .blocked-by { color: var(--map-waiting-text); }.body-ready { color: var(--success-text); }.body-initializing { display: inline-flex; align-items: center; gap: 4px; color: var(--active-text); font-weight: 750; }.content-spinner { display: inline-block; width: 11px; height: 11px; flex: 0 0 11px; border: 2px solid color-mix(in srgb,currentColor 28%,transparent); border-top-color: currentColor; border-radius: 50%; animation: task-map-spin .75s linear infinite; }
  .task-map-shell.dense .task-node { grid-template-rows: auto minmax(0,1fr); gap: 5px; border-radius: var(--radius-sm); padding: 7px 8px; }.task-map-shell.dense .task-node > strong { align-self: center; font-size: 11px; line-height: 1.22; }.task-map-shell.dense .node-id { min-width: 42px; height: 18px; font-size: 8px; }.task-map-shell.dense .node-state { font-size: 8px; }.task-map-shell.dense .node-meta,.task-map-shell.dense .node-foot { display: none; }
  .map-lower-grid { display: grid; grid-template-columns: minmax(340px, .85fr) minmax(0, 1.15fr); }
  .attention-panel { min-width: 0; border-right: 1px solid var(--border); }.attention-panel > header { display: flex; min-height: 74px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-soft); padding: 14px 18px; background: var(--ink-900); color: var(--ink-50); }.attention-panel h3 { margin: 0; font-size: 14px; }.attention-panel > header > span { display: grid; width: 30px; height: 30px; place-items: center; border-radius: var(--radius-sm); background: var(--warning-500); color: #fff; font-weight: 900; }.attention-panel .map-eyebrow { color: var(--brand-200); }.attention-items { display: grid; max-height: 190px; overflow: auto; padding: 5px; }.attention-items button { display: grid; grid-template-columns: 30px minmax(0,1fr); align-items: center; gap: 10px; border: 0; border-radius: var(--radius); padding: 9px 10px; background: transparent; color: var(--text); text-align: left; }.attention-items button:hover { background: var(--surface-soft); }.attention-items button.initializing { background: var(--active-surface); }.attention-items button > span:first-child { display: grid; width: 28px; height: 28px; place-items: center; border-radius: var(--radius-sm); background: var(--warning-surface); color: var(--warning-600); font-size: 11px; font-weight: 800; }.attention-items button.initializing > span:first-child { background: var(--surface-raised); color: var(--active-text); }.attention-items strong,.attention-items small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.attention-items strong { font-size: 12px; }.attention-items small { margin-top: 2px; color: var(--text-subtle); font-size: 11px; }.attention-items button.initializing small { color: var(--active-text); font-weight: 700; }.attention-empty { margin: 0; padding: 24px 18px; color: var(--text-muted); font-size: 12px; }
  .selection-panel { display: flex; min-width: 0; min-height: 190px; align-items: flex-end; justify-content: space-between; gap: 28px; padding: 18px 20px; }.selection-panel > div { min-width: 0; }.selection-panel h3 { overflow: hidden; margin: 9px 0 5px; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }.selection-panel p:last-child { display: -webkit-box; max-width: 720px; overflow: hidden; margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.55; line-clamp: 3; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }.selected-identity { display: flex; align-items: center; gap: 8px; }.selected-identity > strong { color: var(--active-text); font: 800 11px/1 "SFMono-Regular",Consolas,monospace; }.selected-identity > span { border-radius: var(--radius-full); padding: 4px 7px; background: var(--surface-soft); color: var(--text-muted); font-size: 11px; font-weight: 800; text-transform: uppercase; }.selected-identity > span[data-tone="blocked"] { border: 1px solid var(--map-blocked-border); background: var(--map-blocked-surface); color: var(--map-blocked-text); }.selected-identity > span[data-tone="waiting"] { border: 1px solid var(--map-waiting-border); background: var(--map-waiting-surface); color: var(--map-waiting-text); }.selected-identity > span[data-tone="done"] { background: var(--success-surface); color: var(--success-text); }.selection-panel > button { flex: 0 0 auto; border: 1px solid var(--border); border-radius: var(--radius); padding: 9px 11px; background: var(--surface); color: var(--active-text); font-size: 12px; font-weight: 750; }.selection-panel > button:hover { border-color: var(--brand-300); background: var(--active-surface); }.selection-panel > button span { margin-left: 7px; }.map-empty { display: grid; min-height: 300px; place-content: center; gap: 5px; color: var(--text-muted); text-align: center; }.map-empty strong { color: var(--text); font-size: 15px; }.map-empty span { font-size: 12px; }
  @media (max-width: 920px) { .map-header { display: grid; }.map-summary { width: 100%; }.map-lower-grid { grid-template-columns: 1fr; }.attention-panel { border-right: 0; border-bottom: 1px solid var(--border); }.selection-panel { align-items: flex-start; }.map-header,.map-legend { padding-right: 16px; padding-left: 16px; } }
  @media (max-width: 620px) { .map-summary { grid-template-columns: repeat(2,1fr); }.map-summary > span:nth-child(3) { border-top: 1px solid var(--border); border-left: 0; }.map-summary > span:nth-child(4) { border-top: 1px solid var(--border); }.selection-panel { display: grid; }.selection-panel > button { justify-self: start; } }
  @keyframes task-map-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .task-node,.task-edge { transition: none; }.content-spinner { animation-duration: 1.5s; } }
</style>
