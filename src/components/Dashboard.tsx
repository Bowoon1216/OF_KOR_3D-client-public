import { ArrowRight, Boxes, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isValidRoomCode, normalizeRoomCode } from '../api/rooms';
import { useAuth } from '../auth/AuthContext';
import NewSessionDialog from './NewSessionDialog';

export default function Dashboard() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);

  // 방 생성은 로그인이 필요합니다(명세 4.1). 입장과 달리 게스트로는 만들 수 없습니다.
  const handleNewSession = () => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }
    setDialogOpen(true);
  };

  // 내 에셋 목록도 로그인이 필요합니다(명세 5.1 `GET /api/assets`).
  const handleMyAssets = () => {
    navigate(isAuthenticated ? '/assets' : '/login');
  };

  // 방 입장은 게스트도 가능하므로(명세 1.2) 로그인으로 보내지 않습니다.
  const handleJoin = () => {
    setJoinError(undefined);
    if (!isValidRoomCode(joinCode)) {
      setJoinError('방 코드는 8자리 숫자입니다. (예: 1234-5678)');
      return;
    }
    navigate(`/room/${normalizeRoomCode(joinCode)}`);
  };

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-8 py-20 text-center">
        <span className="mb-6 text-[10px] font-bold uppercase tracking-[0.3em] text-blue-600">
          Collaboration
        </span>
        <h1 className="mb-8 font-serif text-6xl leading-[1.1]">
          Start your <br />
          <span className="font-light italic">3D Session</span>
        </h1>
        <p className="mb-12 text-sm font-medium leading-relaxed text-slate-500">
          Create a new low-latency 3D architectural review session or join an existing one using
          KOREN's high-speed backbone network.
        </p>

        <div className="w-full space-y-6 text-left">
          <button
            onClick={handleNewSession}
            className="group flex w-full cursor-pointer items-center justify-between bg-slate-900 px-8 py-5 text-white transition-colors hover:bg-slate-800"
          >
            <div className="flex items-center gap-4">
              <Plus className="h-5 w-5" />
              <span className="text-xs font-bold uppercase tracking-widest">New Session</span>
            </div>
            <ArrowRight className="h-5 w-5 opacity-50 transition-opacity duration-300 group-hover:translate-x-1 group-hover:opacity-100" />
          </button>

          <button
            onClick={handleMyAssets}
            className="group flex w-full cursor-pointer items-center justify-between border border-slate-900 bg-white px-8 py-5 text-slate-900 transition-colors hover:bg-slate-900 hover:text-white"
          >
            <div className="flex items-center gap-4">
              <Boxes className="h-5 w-5" />
              <span className="text-xs font-bold uppercase tracking-widest">My Assets</span>
            </div>
            <ArrowRight className="h-5 w-5 opacity-50 transition-opacity duration-300 group-hover:translate-x-1 group-hover:opacity-100" />
          </button>

          <div className="flex flex-col border border-slate-200">
            <div className="border-b border-slate-200 bg-slate-50 p-5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Join with Code
              </span>
            </div>
            <form
              className="flex gap-4 p-5"
              onSubmit={(event) => {
                event.preventDefault();
                handleJoin();
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 1234-5678"
                value={joinCode}
                onChange={(event) => {
                  setJoinCode(event.target.value);
                  setJoinError(undefined);
                }}
                className="flex-1 rounded-none border-b border-slate-300 bg-transparent pb-2 text-sm font-medium placeholder:text-slate-300 focus:border-slate-900 focus:outline-none"
              />
              <button
                type="submit"
                className="cursor-pointer text-xs font-bold uppercase tracking-widest text-slate-900 transition-colors hover:text-blue-600"
              >
                Join
              </button>
            </form>
            <p className="px-5 pb-5 text-xs text-slate-400">
              로그인 없이도 게스트로 입장할 수 있습니다.
            </p>
          </div>

          {joinError && (
            <p role="alert" className="border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">
              {joinError}
            </p>
          )}
        </div>
      </div>

      {dialogOpen && (
        <NewSessionDialog
          onClose={() => setDialogOpen(false)}
          onEnter={(code) => navigate(`/room/${code}`)}
        />
      )}
    </main>
  );
}
