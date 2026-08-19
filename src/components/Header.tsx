import { ArrowLeft, Check, LogOut, Settings, Share2 } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import ServerSettingsDialog from "./ServerSettingsDialog";

const linkStyle =
  "text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-900 transition-colors flex items-center gap-2 cursor-pointer";

export default function Header() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, isAuthenticated, logout } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const isRoom = pathname.startsWith("/room");
  // Header 는 레이아웃 라우트에 있어 useParams 로는 :code 를 볼 수 없습니다.
  const code = isRoom ? pathname.split("/")[2] : undefined;

  const handleLogout = () => {
    logout();
    navigate("/dashboard");
  };

  /** URL 공유만으로 즉시 참여할 수 있어야 하므로 방 주소를 그대로 복사합니다. */
  const handleInvite = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 권한이 없으면 주소창을 직접 복사하도록 안내합니다.
      window.prompt("아래 주소를 복사해 공유하세요", window.location.href);
    }
  };

  return (
    <>
      <header className="h-20 bg-white border-b border-slate-100 flex items-center justify-between px-10 shrink-0 relative z-20">
        <div className="flex items-center gap-8">
          <div
            className="text-2xl font-bold tracking-tighter italic font-serif underline decoration-2 underline-offset-4 text-slate-900 cursor-pointer"
            onClick={() => navigate("/dashboard")}
          >
            OF_KOR_3D.
          </div>
          <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">
            <span className="text-blue-600">KOREN 넷챌린지 13</span>
            <span>/</span>
            {isRoom && code ? <span>Room {code}</span> : <span>HPC &amp; AI &amp; L2VPN</span>}
          </div>
        </div>
        <div className="flex items-center gap-8">
          {isRoom && (
            <button onClick={() => navigate("/dashboard")} className={linkStyle}>
              <ArrowLeft className="w-4 h-4" />
              Dashboard
            </button>
          )}
          <button onClick={() => setSettingsOpen(true)} className={linkStyle}>
            <Settings className="w-4 h-4" />
            Settings
          </button>
          {isRoom && (
            <button
              onClick={() => void handleInvite()}
              className="px-6 py-2 border border-slate-900 text-[10px] font-bold uppercase tracking-widest text-slate-900 hover:bg-slate-900 hover:text-white transition-colors flex items-center gap-2 cursor-pointer"
            >
              {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
              {copied ? "Copied" : "Invite"}
            </button>
          )}

          {isAuthenticated ? (
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-900">
                  {user?.name}
                </span>
                {/* roleLabel 은 서버가 표시용으로 내려주는 문자열입니다. */}
                <span className="text-[10px] uppercase tracking-widest text-slate-400">
                  {user?.roleLabel}
                </span>
              </div>
              <button onClick={handleLogout} className={linkStyle}>
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-6">
              <button onClick={() => navigate("/login")} className={linkStyle}>
                Login
              </button>
              <button
                onClick={() => navigate("/signup")}
                className="px-6 py-2 bg-slate-900 border border-slate-900 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-slate-900 transition-colors cursor-pointer"
              >
                Sign up
              </button>
            </div>
          )}
        </div>
      </header>

      {settingsOpen && <ServerSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
