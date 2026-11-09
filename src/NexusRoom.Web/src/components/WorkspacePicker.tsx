import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Copy, File, Folder, HardDrive, Home, RefreshCw, Search } from 'lucide-react';
import { api, bytes } from '../api';
import { useRoom } from '../context';
import { Busy, Modal } from './UI';

interface DirectoryEntry { name: string; path: string }
interface FileEntry extends DirectoryEntry { size: number | null; modifiedAt: string | null }
interface WorkspaceDirectory {
  path: string;
  parentPath: string | null;
  defaultPath: string;
  roots: DirectoryEntry[];
  directories: DirectoryEntry[];
  files: FileEntry[];
  truncated: boolean;
}

export function WorkspacePicker({ initialPath, choose, close }: {
  initialPath: string;
  choose: (path: string) => void;
  close: () => void;
}) {
  const { notify } = useRoom();
  const [directory, setDirectory] = useState<WorkspaceDirectory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const sequence = useRef(0);
  const browsePath = useRef(initialPath);
  const navigationClearedQuery = useRef(false);
  const load = async (path = '', filter = '') => {
    const request = ++sequence.current;
    setBusy(true);
    setError('');
    setSelectedFile(null);
    try {
      const parameters = new URLSearchParams();
      if (path) parameters.set('path', path);
      if (filter) parameters.set('query', filter);
      const result = await api<WorkspaceDirectory>('/api/agent/workspace' + (parameters.size ? '?' + parameters : ''));
      if (request === sequence.current) { browsePath.current = result.path; setDirectory(result); }
    } catch (e) {
      if (request === sequence.current) setError((e as Error).message);
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  };
  const navigate = (path = '') => { browsePath.current = path; navigationClearedQuery.current = query.length > 0; setQuery(''); void load(path); };
  useEffect(() => {
    // Navigation already loads the unfiltered folder. Repeating that load after
    // the cleared search debounce would erase a file selected in the meantime.
    if (navigationClearedQuery.current) { navigationClearedQuery.current = false; return; }
    if (!directory) return;
    const timer = window.setTimeout(() => { void load(browsePath.current, query); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => { void load(initialPath); return () => { ++sequence.current; }; }, [initialPath]);

  return <Modal title="选择 PC 工作目录" close={close} wide>
    <p className="workspace-description">浏览这台电脑的文件夹及其中的文件，进入所需目录后点击「选择此文件夹」。点击文件可查看信息。</p>
    <div className="workspace-browser" aria-busy={busy}>
      <nav className="workspace-locations" aria-label="电脑位置">
        <button disabled={busy} onClick={() => navigate()}><Home size={18}/>用户主目录</button>
        <span>此电脑</span>
        {directory?.roots.map(root => <button key={root.path} disabled={busy} onClick={() => navigate(root.path)}><HardDrive size={18}/>{root.name}</button>)}
      </nav>
      <section className="workspace-content">
        <div className="workspace-navigation">
          <button className="icon-btn" aria-label="返回上级目录" disabled={busy || !directory?.parentPath} onClick={() => navigate(directory?.parentPath || '')}><ArrowUp size={19}/></button>
          <output aria-label="当前文件夹" title={directory?.path}>{directory?.path || '用户主目录'}</output>
          <button className="icon-btn" aria-label="刷新目录" disabled={busy} onClick={() => void load(directory?.path || initialPath, query)}><RefreshCw size={17}/></button>
        </div>
        {error && <p className="workspace-error" role="alert">{error}</p>}
        <label className="workspace-search"><Search size={16}/><input aria-label="搜索当前目录的文件和文件夹" placeholder="搜索此目录中的文件和文件夹" value={query} maxLength={100} disabled={!directory} onChange={e => setQuery(e.target.value)}/></label>
        <div className="workspace-folders" aria-label="文件和文件夹">
          {busy ? <div className="workspace-empty"><Busy text="正在读取电脑目录…"/></div> : <>
            {directory?.directories.map(entry => <button key={entry.path} className="workspace-folder" onClick={() => navigate(entry.path)}><Folder size={20}/><span>{entry.name}</span><small>打开文件夹</small></button>)}
            {directory?.files.map(entry => <button key={entry.path} className="workspace-folder workspace-file" aria-label={`${entry.name} 查看文件信息`} aria-pressed={selectedFile?.path === entry.path} onClick={() => setSelectedFile(entry)}><File size={20}/><span>{entry.name}<small>{fileType(entry.name)} · {entry.size === null ? '大小未知' : bytes(entry.size)}</small></span><small>查看信息</small></button>)}
            {directory && !directory.directories.length && !directory.files.length && <p className="workspace-empty">{query ? '没有匹配的文件或文件夹，可更改搜索词。' : '此目录为空，可以直接选择。'}</p>}
          </>}
        </div>
        {directory?.truncated && <p className="workspace-description">项目较多，文件夹和文件各显示前 1,000 项；输入名称可搜索整个当前目录。</p>}
        {selectedFile && <section className="workspace-file-details" aria-label="文件详情"><strong>{selectedFile.name}</strong><span>{fileType(selectedFile.name)} · {selectedFile.size === null ? '大小未知' : bytes(selectedFile.size)}</span>{selectedFile.modifiedAt && <span>修改时间：{new Date(selectedFile.modifiedAt).toLocaleString('zh-CN')}</span>}<output aria-label="文件路径">{selectedFile.path}</output><button className="text-btn" onClick={() => void navigator.clipboard.writeText(selectedFile.path).then(() => notify('文件路径已复制')).catch(() => notify('请手动复制文件路径', true))}><Copy size={13}/>复制文件路径</button></section>}
      </section>
    </div>
    <div className="workspace-selection"><span>文件夹</span><output>{directory?.path || '尚未选择'}</output></div>
    <div className="modal-actions"><button className="btn secondary" onClick={close}>取消</button><button className="btn primary" disabled={busy || !!error || !directory} onClick={() => { if (directory) choose(directory.path); }}>选择此文件夹</button></div>
  </Modal>;
}

function fileType(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? `${name.slice(dot + 1).toUpperCase()} 文件` : '文件';
}
