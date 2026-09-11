import { useEffect, useState, type FocusEvent, type KeyboardEvent } from "react";
import { formatMMSS, parseMMSS } from "./formatTime";

/**
 * Binds a seconds-valued model field to a text input that reads and writes `m:ss`.
 *
 * The draft text is kept locally while the field has focus, so mid-typing states like `"1:"` are
 * not fought by a reformat on every keystroke; the value is committed on blur or Enter. Anything
 * unparseable reverts to the last good value rather than clamping to something the user did not
 * ask for — a silent 0 would be indistinguishable from a real edit.
 *
 * Returns props to spread onto the `<input>`, so the two fields that need this (the timeline's
 * total length and a Load's start/duration) cannot implement the focus dance slightly differently.
 */
export function useMMSSDraft(
  value: number,
  onCommit: (seconds: number) => void,
  /** Applied to the parsed value before it is committed and echoed back — e.g. snapping the
   *  timeline's total length to the drag grid. Identity when omitted. */
  normalize: (seconds: number) => number = (seconds) => seconds,
) {
  const [text, setText] = useState(() => formatMMSS(value));
  const [focused, setFocused] = useState(false);

  // Track the model while the user isn't editing: a drag on the canvas has to show up here, but it
  // must not overwrite half-typed text.
  useEffect(() => {
    if (!focused) setText(formatMMSS(value));
  }, [value, focused]);

  function commit(raw: string) {
    const parsed = parseMMSS(raw);
    if (parsed === null) {
      setText(formatMMSS(value));
      return;
    }
    const next = normalize(parsed);
    onCommit(next);
    setText(formatMMSS(next));
  }

  return {
    type: "text" as const,
    inputMode: "numeric" as const,
    placeholder: "m:ss",
    value: text,
    onFocus: () => setFocused(true),
    onChange: (event: { target: { value: string } }) => setText(event.target.value),
    onBlur: (event: FocusEvent<HTMLInputElement>) => {
      setFocused(false);
      commit(event.target.value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") event.currentTarget.blur();
    },
  };
}
