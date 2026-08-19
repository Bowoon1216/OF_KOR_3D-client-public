import { ReactNode } from 'react';

export interface AuthLayoutProps {
  /** 카드 상단의 작은 대문자 라벨 */
  eyebrow: string;
  title: string;
  description?: string;
  /** 폼 전체에 걸친 에러 (로그인 실패 등) */
  error?: string;
  children: ReactNode;
  /** 카드 하단 영역 - 페이지 전환 링크 등 */
  footer?: ReactNode;
}

/** 로그인 / 회원가입 페이지가 공유하는 화면 껍데기 */
export default function AuthLayout({
  eyebrow,
  title,
  description,
  error,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <main className="grid min-h-screen place-items-center bg-white px-6 py-16 font-sans text-slate-900">
      <section className="w-full max-w-md">
        <div className="mb-10 text-center text-2xl font-bold italic tracking-tighter underline decoration-2 underline-offset-4 font-serif">
          OF_KOR_3D.
        </div>

        <div className="border border-slate-200 bg-white p-10 shadow-sm">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-blue-600">
            {eyebrow}
          </p>
          <h1 className="mb-2 text-3xl font-serif italic">{title}</h1>
          {description && (
            <p className="mb-8 text-sm leading-relaxed text-slate-500">
              {description}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="mb-6 border border-red-100 bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-600"
            >
              {error}
            </p>
          )}

          {children}
        </div>

        {footer && (
          <div className="mt-8 text-center text-xs text-slate-500">{footer}</div>
        )}
      </section>
    </main>
  );
}
