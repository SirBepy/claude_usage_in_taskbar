export interface CtaAction {
  label: string;
  /** Phosphor icon name without the "ph-" prefix (e.g. "hand-fist"). */
  icon?: string;
  handler: () => void | Promise<void>;
}

const _registry = new Map<string, CtaAction>();

export function registerCta(id: string, action: CtaAction): void {
  _registry.set(id, action);
}

export function getCta(id: string): CtaAction | undefined {
  return _registry.get(id);
}
