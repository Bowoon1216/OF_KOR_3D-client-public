import { AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toMessage } from '../api/errors';
import { useRoomQuery } from '../api/queries';
import { isValidRoomCode, normalizeRoomCode } from '../api/rooms';
import { useAuth } from '../auth/AuthContext';
import AssetPickerDialog from '../components/AssetPickerDialog';
import Button from '../components/Button';
import ControlPanel from '../components/ControlPanel';
import Sidebar from '../components/Sidebar';
import TextField from '../components/TextField';
import Viewer from '../components/Viewer';
import { useRoom } from '../realtime/useRoom';

/** 게스트가 이름을 넣기 전에는 join 을 호출하지 않습니다. */
function GuestGate({
  code,
  onSubmit,
  onGoToLogin,
}: {
  code: string;
  onSubmit: (name: string) => void;
  onGoToLogin: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();

  return (
    <main className="grid flex-1 place-items-center bg-white p-8">
      <section className="w-full max-w-md border border-slate-200 p-10">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-blue-600">Join session</p>
        <h1 className="mb-2 font-serif text-3xl italic">{code}</h1>
        <p className="mb-8 text-sm leading-relaxed text-slate-500">
          회원가입 없이 게스트로 참여할 수 있습니다. 참가자 명단에 표시될 이름을 입력해 주세요.
        </p>
        <form
          className="flex flex-col gap-6"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) {
              setError('이름을 입력해 주세요.');
              return;
            }
            onSubmit(trimmed);
          }}
        >
          <TextField
            label="이름"
            name="guestName"
            placeholder="예: 건축주"
            value={name}
            error={error}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
          />
          <Button type="submit" fullWidth>
            게스트로 입장
          </Button>
        </form>
        <button
          type="button"
          onClick={onGoToLogin}
          className="mt-8 w-full text-center text-xs text-slate-500 underline underline-offset-4 hover:text-slate-900 cursor-pointer"
        >
          계정으로 로그인하고 입장
        </button>
      </section>
    </main>
  );
}

/** 세션 룸 화면 (/room/:code) */
export default function MainPage() {
  const { code: rawCode } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading } = useAuth();

  // 제스처 인식 사용 여부는 Viewer(카메라)와 ControlPanel(토글)이 함께 쓰므로 여기서 관리합니다.
  const [gestureEnabled, setGestureEnabled] = useState(false);
  const [guestName, setGuestName] = useState<string | null>(null);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);

  // joinToRender 측정의 시작점. 이 화면에 들어온 시각을 한 번만 기록합니다.
  const joinedAtRef = useRef(performance.now());

  const code = useMemo(
    () => (rawCode && isValidRoomCode(rawCode) ? normalizeRoomCode(rawCode) : null),
    [rawCode],
  );

  const roomQuery = useRoomQuery(code ?? '', { enabled: Boolean(code) });

  // 로그인 사용자는 계정 이름으로 바로 입장하고, 게스트만 이름을 먼저 받습니다.
  const displayName = isAuthenticated ? user?.name : guestName;
  const ready = Boolean(code) && !isLoading && Boolean(displayName);

  const room = useRoom({
    code: code ?? '',
    name: displayName ?? undefined,
    enabled: ready,
  });

  const { setTracking, setPresence, sendTransform } = room;

  const handleTracking = useCallback(
    (status: 'ok' | 'lost', reason?: Parameters<typeof setTracking>[1]) => {
      setTracking(status, reason);
    },
    [setTracking],
  );

  // 방이 끝나면 대시보드로 돌려보냅니다.
  useEffect(() => {
    if (!room.endedReason) return;
    const timer = window.setTimeout(() => navigate('/dashboard'), 2500);
    return () => window.clearTimeout(timer);
  }, [room.endedReason, navigate]);

  if (!code) {
    return (
      <main className="grid flex-1 place-items-center bg-white p-8 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-6 h-6 w-6 text-slate-300" />
          <p className="mb-6 text-sm text-slate-500">방 코드는 8자리 숫자입니다. (예: 1234-5678)</p>
          <Button onClick={() => navigate('/dashboard')}>대시보드로</Button>
        </div>
      </main>
    );
  }

  if (roomQuery.isError) {
    return (
      <main className="grid flex-1 place-items-center bg-white p-8 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-6 h-6 w-6 text-red-400" />
          <p className="mb-6 text-sm text-red-600">{toMessage(roomQuery.error)}</p>
          <Button variant="outline" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="mr-2 inline h-4 w-4" />
            대시보드로
          </Button>
        </div>
      </main>
    );
  }

  if (!isLoading && !isAuthenticated && !guestName) {
    return (
      <GuestGate code={code} onSubmit={setGuestName} onGoToLogin={() => navigate('/login')} />
    );
  }

  if (!ready || roomQuery.isPending) {
    return (
      <main className="grid flex-1 place-items-center bg-white">
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          세션에 입장하는 중...
        </div>
      </main>
    );
  }

  const holderName =
    room.control.holder && room.control.holder !== room.me?.id
      ? room.control.holderName ??
        room.roster.find((p) => p.id === room.control.holder)?.name ??
        null
      : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {(room.status === 'reconnecting' || room.error || room.endedReason) && (
        <div
          role="status"
          className={`flex items-center gap-3 px-10 py-3 text-[10px] font-bold uppercase tracking-widest ${
            room.endedReason ? 'bg-slate-900 text-white' : 'bg-amber-50 text-amber-700'
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {room.endedReason
            ? '세션이 종료되었습니다. 대시보드로 이동합니다.'
            : room.error ?? room.statusMessage ?? '재접속 중...'}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          roster={room.roster}
          myId={room.me?.id}
          status={room.status}
          onPresenceChange={setPresence}
        />
        <Viewer
          gestureEnabled={gestureEnabled}
          asset={room.asset}
          remoteState={room.remoteState}
          onTransform={sendTransform}
          roomCode={code}
          participantId={room.me?.id}
          joinedAtMs={joinedAtRef.current}
          // 도면 교체는 방 소유자(호스트)만 가능합니다. 아니면 서버가 403 을 냅니다.
          canChangeAsset={Boolean(room.me?.isHost) && isAuthenticated}
          onRequestAssetChange={() => setAssetPickerOpen(true)}
          controlHolderName={holderName}
          onTrackingChange={handleTracking}
        />
        <ControlPanel
          gestureEnabled={gestureEnabled}
          onGestureEnabledChange={setGestureEnabled}
          telemetry={room.telemetry}
          clock={room.clock}
        />
      </div>

      {assetPickerOpen && (
        <AssetPickerDialog
          roomCode={code}
          currentAssetId={room.asset?.id}
          onClose={() => setAssetPickerOpen(false)}
        />
      )}
    </div>
  );
}
