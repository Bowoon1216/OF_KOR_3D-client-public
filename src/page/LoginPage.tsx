import { useState } from 'react';
import { isApiError } from '../api/errors';
import AuthLayout from '../components/AuthLayout';
import Button from '../components/Button';
import TextField from '../components/TextField';

export interface LoginFormValues {
  email: string;
  password: string;
}

export interface LoginPageProps {
  /** 실제 로그인 처리. 실패 시 throw 하면 폼 상단에 메시지가 노출됩니다. */
  onSubmit?: (values: LoginFormValues) => void | Promise<void>;
  onGoToSignup?: () => void;
}

type FieldErrors = Partial<Record<keyof LoginFormValues, string>>;

export default function LoginPage({ onSubmit, onGoToSignup }: LoginPageProps) {
  const [values, setValues] = useState<LoginFormValues>({ email: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const setField = (key: keyof LoginFormValues) => (value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    setFormError(undefined);
  };

  // 로그인에서는 형식까지 따지지 않고 입력 여부만 확인합니다.
  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!values.email.trim()) next.email = '이메일을 입력해 주세요.';
    if (!values.password) next.password = '비밀번호를 입력해 주세요.';
    return next;
  };

  const handleSubmit = async () => {
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    setFormError(undefined);
    try {
      await onSubmit?.({ email: values.email.trim(), password: values.password });
    } catch (error) {
      // 서버는 없는 이메일과 틀린 비밀번호를 구분하지 않습니다(계정 열거 방지).
      // 그 메시지를 그대로 보여줍니다.
      if (isApiError(error)) {
        const fields = error.fieldErrors();
        if (Object.keys(fields).length > 0) {
          setErrors({ email: fields.email, password: fields.password });
        }
        setFormError(error.message);
      } else {
        setFormError(
          error instanceof Error
            ? error.message
            : '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Sign in"
      title="로그인"
      description="가입한 이메일과 비밀번호를 입력해 주세요."
      error={formError}
      footer={
        <span>
          아직 계정이 없으신가요?{' '}
          <button
            type="button"
            onClick={onGoToSignup}
            className="font-bold text-slate-900 underline underline-offset-4 hover:text-blue-600 cursor-pointer"
          >
            회원가입
          </button>
        </span>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <TextField
          label="이메일"
          name="email"
          type="email"
          autoComplete="username"
          placeholder="name@cau.ac.kr"
          value={values.email}
          error={errors.email}
          onChange={(event) => setField('email')(event.target.value)}
        />
        <TextField
          label="비밀번호"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="비밀번호를 입력하세요"
          value={values.password}
          error={errors.password}
          onChange={(event) => setField('password')(event.target.value)}
        />
        <Button type="submit" fullWidth disabled={submitting} className="mt-2">
          {submitting ? '로그인 중...' : '로그인'}
        </Button>
      </form>
    </AuthLayout>
  );
}
