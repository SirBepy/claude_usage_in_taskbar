export interface PermissionRequestedPayload {
  id: string;
  tool_name: string;
  input: unknown;
  session_id?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

export interface QuestionRequestedPayload {
  id: string;
  questions: Question | Question[];
  session_id?: string;
}

export type Answers = Record<string, string | string[]>;

export type Selection = string | Set<string>;

export interface QuestionDraft {
  freeText: Map<number, string>;
  selections: Map<number, Selection>;
  activeTab: number;
}

export interface QuestionUIOpts {
  /** Prompt id, so the card can be torn down externally (expiry / resolved elsewhere). */
  id?: string;
  /** Session the prompt belongs to - used to scope draft snapshots. */
  sessionId?: string;
  questions: Question[];
  titleIcon: string;
  titleText: string;
  rightChipHtml?: string;
  submitLabel: string;
  submitIcon: string;
  onSubmit: (answers: Answers) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  cancelLabel: string;
  /** Partial answers to restore when re-surfacing a parked card. */
  initialDraft?: QuestionDraft;
}
