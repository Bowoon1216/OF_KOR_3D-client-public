import { useState } from 'react';
import { isApiError } from '../api/errors';
import type { Role } from '../api/types';
import AuthLayout from '../components/AuthLayout';
import Button from '../components/Button';
import TextField from '../components/TextField';
import {
  PASSWORD_RULE_TEXT,
  validateEmail,
  validateName,
  validatePassword,
  validatePasswordConfirm,
} from '../utils/validation';

export interface SignupFormValues {
  email: string;
  name: string;
  role: Role;
  password: string;
  passwordConfirm: string;
}

export interface SignupPageProps {
  /** 실제 가입 처리. 실패 시 throw 하면 폼 상단에 메시지가 노출됩니다. */
  onSubmit?: (values: SignupFormValues) => void | Promise<void>;
  onGoToLogin?: () => void;
}

type FieldErrors = Partial<Record<keyof SignupFormValues, string>>;

/** 라벨은 서버가 내려주는 `roleLabel` 과 같은 문자열을 씁니다. */
const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'host', label: 'Architect (Host)' },
  { value: 'engineer', label: 'Structural Engineer' },
  { value: 'viewer', label: 'Viewer' },
];

export default function SignupPage({ onSubmit, onGoToLogin }: SignupPageProps) {
  const [values, setValues] = useState<SignupFormValues>({
    email: '',
    name: '',
    role: 'engineer',
    password: '',
    passwordConfirm: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const setField =
    <K extends keyof SignupFormValues>(key: K) =>
    (value: SignupFormValues[K]) => {
      setValues((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => ({ ...prev, [key]: undefined }));
      setFormError(undefined);
    };

  const validate = (): FieldErrors => {
    const email = validateEmail(values.email.trim());
    const name = validateName(values.name.trim());
    const password = validatePassword(values.password);
    const passwordConfirm = validatePasswordConfirm(values.password, values.passwordConfirm);

    return {
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(password ? { password } : {}),
      ...(passwordConfirm ? { passwordConfirm } : {}),
    };
  };

  const handleSubmit = async () => {
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    setFormError(undefined);
    try {
      await onSubmit?.({
        ...values,
        email: values.email.trim(),
        name: values.name.trim(),
      });
    } catch (error) {
      if (isApiError(error)) {
        // 422 는 필드별 오류가 실려 옵니다. 해당 입력 아래에 그대로 붙입니다.
        const fields = error.fieldErrors();
        setErrors((prev) => ({
          ...prev,
          email: fields.email ?? (error.code === 'EMAIL_TAKEN' ? error.message : undefined),
          name: fields.name,
          password: fields.password,
        }));
        setFormError(error.message);
      } else {
        setFormError(
          error instanceof Error
            ? error.message
            : '회원가입에 실패했습니다. 잠시 후 다시 시도해 주세요.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Create account"
      title="회원가입"
      description="이메일과 표시 이름만으로 바로 시작할 수 있습니다."
      error={formError}
      footer={
        <span>
          이미 계정이 있으신가요?{' '}
          <button
            type="button"
            onClick={onGoToLogin}
            className="font-bold text-slate-900 underline underline-offset-4 hover:text-blue-600 cursor-pointer"
          >
            로그인
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
          label="이름"
          name="name"
          autoComplete="name"
          placeholder="세션에서 보일 이름"
          value={values.name}
          error={errors.name}
          onChange={(event) => setField('name')(event.target.value)}
        />

        <div className="flex flex-col gap-2">
          <label
            htmlFor="signup-role"
            className="text-[10px] font-bold uppercase tracking-widest text-slate-400"
          >
            역할
          </label>
          <select
            id="signup-role"
            name="role"
            value={values.role}
            onChange={(event) => setField('role')(event.target.value as Role)}
            className="h-12 w-full border border-slate-200 bg-white px-4 text-sm text-slate-900 transition-colors focus:border-slate-900 focus:outline-none"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs leading-relaxed text-slate-400">
            방을 만들 때 기본으로 적용되는 역할입니다. 방마다 바꿀 수 있습니다.
          </p>
        </div>

        <TextField
          label="비밀번호"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="비밀번호를 입력하세요"
          value={values.password}
          error={errors.password}
          hint={PASSWORD_RULE_TEXT}
          onChange={(event) => setField('password')(event.target.value)}
        />
        <TextField
          label="비밀번호 확인"
          name="passwordConfirm"
          type="password"
          autoComplete="new-password"
          placeholder="비밀번호를 다시 입력하세요"
          value={values.passwordConfirm}
          error={errors.passwordConfirm}
          onChange={(event) => setField('passwordConfirm')(event.target.value)}
        />
        <Button type="submit" fullWidth disabled={submitting} className="mt-2">
          {submitting ? '가입 중...' : '회원가입'}
        </Button>
      </form>
    </AuthLayout>
  );
}
