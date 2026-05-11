export interface SuggestProvider<T> {
  triggerChar: string;
  shouldTrigger(ctx: { textBefore: string; caretPos: number }): boolean;
  query(token: string): T[];
  renderRow(item: T, selected: boolean): HTMLElement;
  onPick(item: T, textarea: HTMLTextAreaElement, tokenRange: [number, number]): void;
}

export interface PopupOptions<T> {
  anchor: HTMLElement;
  textarea: HTMLTextAreaElement;
  provider: SuggestProvider<T>;
}
