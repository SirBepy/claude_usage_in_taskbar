# Split running-instances logic out of project-detail.ts

## Goal

Extract the running-instances section from `project-detail.ts` into its own module to bring the file under 400 lines.

## Context

`project-detail.ts` is 539 lines. The running-instances concern (`Instance`/`InstanceStats` interfaces, `instanceRowHtml`, `setRunningInstancesEmpty`, `renderRunningInstances`) is self-contained and distinct from the chart/sessions content. It listens to `api.onInstancesChanged` and populates `#runningInstancesList` / `#runningInstancesEmpty`.

The split seam is at the boundary between the instances section and the chart section (~line 120 in the file).

## Approach

1. Create `src/views/project-detail/subviews/running-instances/running-instances.ts`.
2. Move `Instance`, `InstanceStats`, `instanceRowHtml`, `setRunningInstancesEmpty`, `renderRunningInstances` into it. Export `renderRunningInstances`.
3. In `project-detail.ts`, replace the moved code with an import.
4. Move any relevant CSS from `project-detail.css` into `running-instances.css` (the `.instance-row` rules and `.status-dot` rules).

## Acceptance

- `project-detail.ts` drops below 400 lines.
- Running instances section still renders and updates on `instances-changed` events.
- No visual regression in the project detail view.
