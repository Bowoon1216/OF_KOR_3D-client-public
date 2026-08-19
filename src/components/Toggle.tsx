export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 스크린리더용 이름 */
  label: string;
  disabled?: boolean;
}

/** 켜기/끄기 스위치 */
export default function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked
          ? 'border-slate-900 bg-slate-900'
          : 'border-slate-300 bg-white'
      } ${disabled ? '' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 transition-all ${
          checked ? 'left-6 bg-white' : 'left-1 bg-slate-300'
        }`}
      />
    </button>
  );
}
