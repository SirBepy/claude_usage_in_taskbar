import type { NewsPost } from "../../types/ipc.generated";

export interface NewsState {
  posts: NewsPost[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  notifyEnabled: boolean;
  menuOpen: boolean;
  selectedSlug: string | null;
  generatingSlugs: Set<string>;
  errorBySlug: Map<string, string>;
  streamBySlug: Map<string, string>;
  phaseBySlug: Map<string, string>;
}

export const state: NewsState = {
  posts: [],
  loading: true,
  refreshing: false,
  error: null,
  notifyEnabled: false,
  menuOpen: false,
  selectedSlug: null,
  generatingSlugs: new Set(),
  errorBySlug: new Map(),
  streamBySlug: new Map(),
  phaseBySlug: new Map(),
};

let _paint: (root: HTMLElement) => void = () => {};
export function setPaint(fn: (root: HTMLElement) => void): void { _paint = fn; }
export function paint(root: HTMLElement): void { _paint(root); }
