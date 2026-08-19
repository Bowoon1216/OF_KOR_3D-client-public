import { forwardRef, InputHTMLAttributes, useId } from 'react';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** 입력 아래에 붉은색으로 노출되는 검증 메시지 */
  error?: string;
  /** 에러가 없을 때 노출되는 안내 문구 */
  hint?: string;
}

/** 로그인 / 회원가입에서 공통으로 쓰는 라벨 + 인풋 + 메시지 묶음 */
const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, error, hint, className = '', id, ...inputProps }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const messageId = `${inputId}-message`;
    const message = error ?? hint;

    return (
      <div className="flex flex-col gap-2">
        <label
          htmlFor={inputId}
          className="text-[10px] font-bold uppercase tracking-widest text-slate-400"
        >
          {label}
        </label>
        <input
          {...inputProps}
          id={inputId}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className={`h-12 w-full border bg-white px-4 text-sm text-slate-900 placeholder:text-slate-300 transition-colors focus:outline-none ${
            error
              ? 'border-red-400 focus:border-red-500'
              : 'border-slate-200 focus:border-slate-900'
          } ${className}`}
        />
        {message && (
          <p
            id={messageId}
            className={`text-xs leading-relaxed ${
              error ? 'text-red-500' : 'text-slate-400'
            }`}
          >
            {message}
          </p>
        )}
      </div>
    );
  },
);

TextField.displayName = 'TextField';

export default TextField;
