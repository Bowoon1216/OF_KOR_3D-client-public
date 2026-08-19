import { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'solid' | 'outline';
  fullWidth?: boolean;
}

const variantStyles: Record<NonNullable<ButtonProps['variant']>, string> = {
  solid:
    'bg-slate-900 text-white border border-slate-900 hover:bg-white hover:text-slate-900',
  outline:
    'bg-white text-slate-900 border border-slate-900 hover:bg-slate-900 hover:text-white',
};

export default function Button({
  variant = 'solid',
  fullWidth = false,
  className = '',
  type = 'button',
  disabled,
  children,
  ...buttonProps
}: ButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      disabled={disabled}
      className={`h-12 px-6 text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-900 disabled:hover:text-white ${
        variantStyles[variant]
      } ${fullWidth ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  );
}
