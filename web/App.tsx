import { useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  ArrowRight, ArrowUpRight, BookOpen, Bookmark, Check, ChevronDown, CircleHelp,
  ClipboardList, Compass, ExternalLink, FilePlus2,
  FileText, FolderOpen, LoaderCircle, Menu, Plus, Search, Sparkles,
  Trash2, X,
} from 'lucide-react';

type View = 'overview' | 'discover' | 'library' | 'evidence' | 'ask';
type Status = { ready: boolean; hnsw: boolean; aiConfigured: boolean };
type Project = {
  projectId: string; title: string; researchQuestion: string; createdAt: string;
  paperCount: number; evidenceCount: number;
};
type Paper = {
  documentId: string; projectId: string; title: string; authors: string[];
  publicationYear: number | null; doi: string | null; openalexId: string | null;
  url: string; totalPages: number; totalChunks: number; indexedAt: string;
};
type DiscoveryPaper = {
  openalexId: string; title: string; authors: string[]; publicationYear: number | null;
  doi: string | null; pdfUrl: string | null; sourceUrl: string;
};
type Hit = {
  vectorId: string; documentId: string; title: string; url: string;
  pageNumber: number; text: string; score: number;
};
type Evidence = {
  evidenceId: string; documentId: string; vectorId: string; kind: string;
  quote: string; pageNumber: number; note: string; createdAt: string;
  title: string; url: string; authors: string[]; publicationYear: number | null;
};
type PaperDraft = {
  url: string; title: string; authors: string; publicationYear: string;
  doi: string; openalexId: string;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const emptyPaper: PaperDraft = { url: '', title: '', authors: '', publicationYear: '', doi: '', openalexId: '' };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The research server is unavailable. Start the project API and try again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

function sourceLink(url: string, page?: number) {
  return page ? `${url}#page=${page}` : url;
}

function shortAuthors(authors: string[]) {
  if (authors.length === 0) return 'Author details unavailable';
  return authors.length > 2 ? `${authors[0]} et al.` : authors.join(' & ');
}

const navItems: { id: View; label: string; icon: typeof BookOpen }[] = [
  { id: 'overview', label: 'Overview', icon: Compass },
  { id: 'discover', label: 'Discover papers', icon: Search },
  { id: 'library', label: 'Paper library', icon: FolderOpen },
  { id: 'evidence', label: 'Evidence matrix', icon: ClipboardList },
  { id: 'ask', label: 'Ask your library', icon: Sparkles },
];

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [view, setView] = useState<View>('overview');
  const [papers, setPapers] = useState<Paper[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [librarySearch, setLibrarySearch] = useState('');
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [discoveryQuery, setDiscoveryQuery] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveryPaper[]>([]);
  const [researchQuery, setResearchQuery] = useState('');
  const [scopePaperId, setScopePaperId] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);
  const scopeTriggerRef = useRef<HTMLButtonElement>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [answer, setAnswer] = useState('');
  const [modal, setModal] = useState<'project' | 'edit-project' | 'paper' | 'evidence' | null>(null);
  const [projectTitle, setProjectTitle] = useState('');
  const [projectQuestion, setProjectQuestion] = useState('');
  const [paperDraft, setPaperDraft] = useState<PaperDraft>(emptyPaper);
  const [selectedHit, setSelectedHit] = useState<Hit | null>(null);
  const [evidenceKind, setEvidenceKind] = useState<'finding' | 'method' | 'limitation' | 'context'>('finding');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [mobileNav, setMobileNav] = useState(false);

  const project = projects.find(item => item.projectId === projectId);
  const selectedPaper = papers.find(item => item.documentId === selectedPaperId);
  const selectedScopeTitle = papers.find(item => item.documentId === scopePaperId)?.title ?? 'All papers in this project';
  const savedVectorIds = new Set(evidence.map(item => item.vectorId));

  function reportError(cause: unknown, fallback: string) {
    setError(cause instanceof Error ? cause.message : fallback);
  }

  async function refreshProjects() {
    const result = await request<{ projects: Project[] }>('/app/projects');
    setProjects(result.projects);
    return result.projects;
  }

  async function loadPapers(id: string, after?: string, search = '') {
    const params = new URLSearchParams({ projectId: id, limit: '50' });
    if (after) params.set('after', after);
    if (search.trim()) params.set('search', search.trim());
    const result = await request<{ papers: Paper[]; nextCursor?: string }>(`/app/papers?${params}`);
    setPapers(previous => after ? [...previous, ...result.papers] : result.papers);
    setNextCursor(result.nextCursor);
  }

  async function loadEvidence(id: string) {
    const result = await request<{ evidence: Evidence[] }>(`/app/evidence?projectId=${encodeURIComponent(id)}`);
    setEvidence(result.evidence);
  }

  useEffect(() => {
    void Promise.all([request<Status>('/app/status'), request<{ projects: Project[] }>('/app/projects')])
      .then(([health, data]) => {
        setStatus(health);
        setProjects(data.projects);
        setProjectId(data.projects[0]?.projectId ?? '');
      })
      .catch(cause => {
        setStatus({ ready: false, hnsw: false, aiConfigured: false });
        reportError(cause, 'Could not connect to the local research server.');
      });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setPapers([]);
    setEvidence([]);
    setNextCursor(undefined);
    setSelectedPaperId(null);
    setHits([]);
    setAnswer('');
    setLibrarySearch('');
    setScopePaperId('');
    setScopeOpen(false);
    void Promise.all([loadPapers(projectId), loadEvidence(projectId)])
      .catch(cause => reportError(cause, 'Could not load this project.'));
  }, [projectId]);

  useEffect(() => {
    if (!scopeOpen) return;
    const dismissOnOutsideClick = (event: PointerEvent) => {
      if (!scopeRef.current?.contains(event.target as Node)) setScopeOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setScopeOpen(false);
        scopeTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismissOnOutsideClick);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsideClick);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [scopeOpen]);

  function navigate(next: View) {
    setView(next);
    setError('');
    setMobileNav(false);
    setScopeOpen(false);
  }

  function editProject() {
    setProjectTitle(project?.title ?? '');
    setProjectQuestion(project?.researchQuestion ?? '');
    setError('');
    setModal(project ? 'edit-project' : 'project');
  }

  function openPaperModal(paper?: DiscoveryPaper) {
    if (!projectId) {
      editProject();
      return;
    }
    setPaperDraft(paper ? {
      url: paper.pdfUrl ?? '', title: paper.title,
      authors: paper.authors.join(', '), publicationYear: String(paper.publicationYear ?? ''),
      doi: paper.doi ?? '', openalexId: paper.openalexId,
    } : emptyPaper);
    setError('');
    setModal('paper');
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('project');
    setError('');
    try {
      if (modal === 'edit-project') {
        await request('/app/projects', { method: 'PATCH', body: JSON.stringify({
          projectId, title: projectTitle, researchQuestion: projectQuestion,
        }) });
        await refreshProjects();
      } else {
        const result = await request<{ project: Project }>('/app/projects', {
          method: 'POST', body: JSON.stringify({ title: projectTitle, researchQuestion: projectQuestion }),
        });
        await refreshProjects();
        setProjectId(result.project.projectId);
        setView('overview');
      }
      setModal(null);
    } catch (cause) {
      reportError(cause, 'Could not save the project.');
    } finally {
      setBusy('');
    }
  }

  async function indexPaper(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) return;
    setBusy('paper');
    setError('');
    try {
      const result = await request<{ paper: Paper }>('/app/papers', {
        method: 'POST',
        body: JSON.stringify({
          projectId, url: paperDraft.url.trim(),
          title: paperDraft.title.trim() || undefined,
          authors: paperDraft.authors.split(',').map(value => value.trim()).filter(Boolean),
          publicationYear: paperDraft.publicationYear ? Number(paperDraft.publicationYear) : undefined,
          doi: paperDraft.doi.trim() || undefined,
          openalexId: paperDraft.openalexId || undefined,
        }),
      });
      await Promise.all([loadPapers(projectId), refreshProjects()]);
      setSelectedPaperId(result.paper.documentId);
      setModal(null);
      setView('library');
    } catch (cause) {
      reportError(cause, 'Could not index this PDF.');
    } finally {
      setBusy('');
    }
  }

  async function discover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (discoveryQuery.trim().length < 3) return;
    setBusy('discover');
    setError('');
    try {
      const result = await request<{ papers: DiscoveryPaper[] }>(
        `/app/discover?q=${encodeURIComponent(discoveryQuery.trim())}`,
      );
      setDiscovered(result.papers);
    } catch (cause) {
      reportError(cause, 'Could not search scholarly papers.');
    } finally {
      setBusy('');
    }
  }

  async function research(mode: 'ask' | 'search') {
    if (!projectId || researchQuery.trim().length < 2) return;
    setBusy(mode);
    setError('');
    setAnswer('');
    setHits([]);
    try {
      const payload = JSON.stringify({
        projectId, query: researchQuery.trim(), documentId: scopePaperId || undefined,
      });
      if (mode === 'ask') {
        const result = await request<{ answer: string; sources: Hit[] }>('/app/ask', { method: 'POST', body: payload });
        setAnswer(result.answer);
        setHits(result.sources);
      } else {
        const result = await request<{ hits: Hit[] }>('/app/search', { method: 'POST', body: payload });
        setHits(result.hits);
      }
    } catch (cause) {
      reportError(cause, 'Could not search this library.');
    } finally {
      setBusy('');
    }
  }

  async function saveEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedHit) return;
    setBusy('evidence');
    setError('');
    try {
      await request('/app/evidence', { method: 'POST', body: JSON.stringify({
        projectId, documentId: selectedHit.documentId, vectorId: selectedHit.vectorId,
        kind: evidenceKind, note: evidenceNote,
      }) });
      await Promise.all([loadEvidence(projectId), refreshProjects()]);
      setModal(null);
      setSelectedHit(null);
      setEvidenceNote('');
    } catch (cause) {
      reportError(cause, 'Could not save this evidence.');
    } finally {
      setBusy('');
    }
  }

  async function removeEvidence(item: Evidence) {
    setBusy(`remove-${item.evidenceId}`);
    setError('');
    try {
      await request('/app/evidence', { method: 'DELETE', body: JSON.stringify({
        projectId, evidenceId: item.evidenceId,
      }) });
      await Promise.all([loadEvidence(projectId), refreshProjects()]);
    } catch (cause) {
      reportError(cause, 'Could not remove this evidence.');
    } finally {
      setBusy('');
    }
  }

  function renderHit(hit: Hit, index: number) {
    return (
      <article className="source-card" key={hit.vectorId}>
        <div className="source-topline"><span className="source-number">{String(index + 1).padStart(2, '0')}</span><span>PAGE {hit.pageNumber}</span></div>
        <h3>{hit.title}</h3>
        <p>{hit.text}</p>
        <div className="source-actions">
          <a href={sourceLink(hit.url, hit.pageNumber)} target="_blank" rel="noopener noreferrer">Open source <ArrowUpRight size={14} /></a>
          <button disabled={savedVectorIds.has(hit.vectorId)} onClick={() => {
            setSelectedHit(hit); setEvidenceKind('finding'); setEvidenceNote(''); setError(''); setModal('evidence');
          }}><Bookmark size={14} /> {savedVectorIds.has(hit.vectorId) ? 'Saved' : 'Save evidence'}</button>
        </div>
      </article>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand"><span className="brand-symbol"><BookOpen size={19} /></span><div><strong>margin<span>.</span></strong><small>Research workspace</small></div><button className="mobile-close" aria-label="Close menu" onClick={() => setMobileNav(false)}><X size={19} /></button></div>
        <div className="sidebar-section-title">Projects</div>
        <div className="project-switcher">
          {projects.map(item => <button key={item.projectId} className={`project-option ${item.projectId === projectId ? 'selected' : ''}`} onClick={() => { setProjectId(item.projectId); setView('overview'); setMobileNav(false); }}><span className="project-monogram">{item.title.slice(0, 1).toUpperCase()}</span><span><strong>{item.title}</strong><small>{item.paperCount} papers · {item.evidenceCount} notes</small></span></button>)}
        </div>
        <button className="new-project" onClick={() => { setProjectTitle(''); setProjectQuestion(''); setError(''); setModal('project'); setMobileNav(false); }}><Plus size={16} /> New research project</button>
        <div className="sidebar-divider" />
        <div className="sidebar-section-title">Workspace</div>
        <nav className="main-nav" aria-label="Research workspace">
          {navItems.map(item => <button key={item.id} aria-current={view === item.id ? 'page' : undefined} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><item.icon size={17} /><span>{item.label}</span>{item.id === 'evidence' && evidence.length > 0 && <em>{evidence.length}</em>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note"><BookOpen size={20} /><p>A little clarity.<br />A lot of possibility.</p><span>Your next insight starts here.</span></div><div className="sidebar-local"><span className="status-dot" /> Personal workspace <span>01</span></div>
        </div>
      </aside>

      {mobileNav && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileNav(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open menu" onClick={() => setMobileNav(true)}><Menu size={21} /></button>
          <div className="breadcrumb"><span>{project?.title ?? 'Research project'}</span><span>/</span><strong className="current-view">{navItems.find(item => item.id === view)?.label}</strong></div>
          <div className={`connection ${status?.ready ? 'online' : 'offline'}`}><span className="status-dot" />{status === null ? 'Connecting' : status.ready ? 'Local library ready' : 'Server offline'}</div>
        </header>

        {error && !modal && <div className="page-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
        {!status?.aiConfigured && status?.ready && <div className="setup-note"><CircleHelp size={15} /><span>Add <code>OPENAI_API_KEY</code> to <code>.env</code> to index PDFs and search their content. Paper discovery and project organization already work.</span></div>}

        <div className="page-scroll" key={view}>
          {view === 'overview' && <div className="page-content overview-page">
            <div className="overview-heading top-heading">
              <div><span className="section-kicker">YOUR RESEARCH, CONNECTED</span><h1>{project?.title ?? 'Room for your next idea.'}</h1><p>From a stack of papers to a clearer perspective.</p></div>
              <button className="secondary-action" onClick={() => openPaperModal()}><Plus size={16} /> {project ? 'Add a paper' : 'Create project'}</button>
            </div>

            <div className="overview-bento">
              <section className="focus-card">
                <div className="focus-orbit" aria-hidden="true"><i /><i /><i /><span><Compass size={34} strokeWidth={1} /></span></div>
                <span className="section-kicker"><span className="status-dot" /> THE QUESTION THAT GUIDES YOU</span>
                <h2>{project?.researchQuestion || 'Every discovery begins with a good question.'}</h2>
                <p>{project?.researchQuestion ? 'Keep this in view. Let your sources lead you somewhere new.' : 'Set a research question to give your reading a direction.'}</p>
                <button className="focus-action" onClick={editProject}>{project ? 'Refine your focus' : 'Start your research'} <ArrowUpRight size={17} /></button>
                <span className="focus-caption" aria-hidden="true">FOLLOW YOUR CURIOSITY</span>
              </section>
              <section className="collection-card">
                <div className="card-topline"><span className="section-kicker">YOUR COLLECTION</span><FolderOpen size={18} /></div>
                <div className="collection-stats">
                  <button onClick={() => navigate('library')}><strong>{String(project?.paperCount ?? 0).padStart(2, '0')}</strong><span>Papers indexed <ArrowUpRight size={13} /></span></button>
                  <button onClick={() => navigate('evidence')}><strong>{String(project?.evidenceCount ?? 0).padStart(2, '0')}</strong><span>Evidence notes <ArrowUpRight size={13} /></span></button>
                </div>
                <div className="collection-footer"><span className={`index-dot ${status?.hnsw ? 'ready' : ''}`} />{status === null ? 'Connecting to your library' : status.hnsw ? 'Search index ready' : 'Search index unavailable'}</div>
              </section>
              <button className="insight-card" onClick={() => navigate('ask')}>
                <span className="insight-icon"><Sparkles size={21} /></span><span><strong>Find the thread.</strong><small>Ask questions. Connect your sources.</small></span><ArrowUpRight size={20} />
              </button>
            </div>

            <section className="overview-section">
              <div className="section-heading"><div><span className="section-kicker">MAKE YOUR NEXT MOVE</span><h2>A little closer to your next insight.</h2></div><span className="section-aside">One source at a time.</span></div>
              <div className="workflow-grid">
                <button className="workflow-card discover-workflow" onClick={() => navigate('discover')}>
                  <div className="workflow-art search-art" aria-hidden="true"><span className="art-search"><Search size={16} /><i /><span>↵</span></span><span className="art-result"><i /><i /></span><span className="art-result"><i /><i /></span><span className="art-orbit" /></div>
                  <div className="workflow-copy"><span className="workflow-step">01 / EXPLORE</span><strong>Discover something new <ArrowUpRight size={17} /></strong><small>Find the papers that move your research forward.</small></div>
                </button>
                <button className="workflow-card library-workflow" onClick={() => navigate('library')}>
                  <div className="workflow-art library-art" aria-hidden="true"><span className="art-paper back" /><span className="art-paper front"><FileText size={19} /><i /><i /><i /><em>YOUR NEXT PERSPECTIVE</em></span><span className="art-tag"><Check size={12} /> Source indexed</span></div>
                  <div className="workflow-copy"><span className="workflow-step">02 / UNDERSTAND</span><strong>Make space for reading <ArrowUpRight size={17} /></strong><small>Your sources, organized and ready to explore.</small></div>
                </button>
                <button className="workflow-card evidence-workflow" onClick={() => navigate('evidence')}>
                  <div className="workflow-art evidence-art" aria-hidden="true"><span className="art-note"><span>“</span><i /><i /><i /><em><Bookmark size={11} /> Saved to your research</em></span><span className="art-link"><ClipboardList size={17} /></span></div>
                  <div className="workflow-copy"><span className="workflow-step">03 / CONNECT</span><strong>Turn reading into evidence <ArrowUpRight size={17} /></strong><small>Capture the findings that support your thinking.</small></div>
                </button>
              </div>
            </section>

            <section className="overview-section recent-section">
              <div className="section-heading"><div><span className="section-kicker">BACK TO THE SOURCES</span><h2>Recently added</h2></div><button className="text-action" onClick={() => navigate('library')}>View library <ArrowRight size={15} /></button></div>
              {papers.length ? <div className="recent-papers">{[...papers].sort((a, b) => b.indexedAt.localeCompare(a.indexedAt)).slice(0, 3).map(paper => <button key={paper.documentId} onClick={() => { setSelectedPaperId(paper.documentId); navigate('library'); }}><span className="paper-badge"><FileText size={18} /></span><span className="recent-copy"><strong>{paper.title}</strong><small>{shortAuthors(paper.authors)} · {paper.publicationYear ?? 'Year unknown'}</small></span><span className="recent-pages">{paper.totalPages} pages</span><ArrowUpRight size={16} /></button>)}</div> : <div className="recent-empty"><span className="paper-badge"><BookOpen size={20} /></span><div><strong>Your next great read belongs here.</strong><p>Add your first paper and start connecting the dots.</p></div><button className="text-action" onClick={() => navigate('discover')}>Find a paper <ArrowRight size={15} /></button></div>}
            </section>
            <footer className="overview-footer"><span>Made for curious minds.</span><span>Read. Question. Connect.</span></footer>
          </div>}

          {view === 'discover' && <div className="page-content">
            <div className="page-heading"><span className="section-kicker">01 / DISCOVER</span><h1>Find papers worth reading.</h1><p>Search open-access scholarly records. Review each source before bringing its PDF into your project.</p></div>
            <form className="large-search" onSubmit={event => void discover(event)}><Search size={19} /><input aria-label="Search scholarly papers" placeholder="Try a topic, method, or research question..." value={discoveryQuery} onChange={event => setDiscoveryQuery(event.target.value)} /><button disabled={busy === 'discover' || discoveryQuery.trim().length < 3}>{busy === 'discover' ? <><LoaderCircle className="spin" size={17} /> Searching...</> : 'Search papers'} <ArrowRight size={16} /></button></form>
            <div className="discovery-source"><Compass size={15} /> Results from OpenAlex · Open-access status does not guarantee a downloadable PDF or reuse rights.</div>
            {discovered.length === 0 ? <div className="empty-state"><span><Search size={27} /></span><h2>A good review starts with a good question.</h2><p>Search a topic to see papers, publication details, and available PDF sources.</p><div className="example-queries">{['retrieval augmented generation evaluation', 'student feedback systems', 'computer vision crop disease'].map(query => <button key={query} onClick={() => setDiscoveryQuery(query)}>{query} <ArrowUpRight size={13} /></button>)}</div></div> : <><div className="results-heading"><strong>{discovered.length} papers found</strong><span>Review titles and source links before indexing</span></div><div className="discovery-list">{discovered.map(item => <article className="discovery-card" key={item.openalexId}><div className="paper-badge"><FileText size={18} /></div><div className="discovery-body"><div className="paper-meta">{item.publicationYear ?? 'YEAR UNKNOWN'} <span>·</span> OPEN ACCESS {item.doi && <><span>·</span> DOI {item.doi}</>}</div><h3>{item.title}</h3><p>{shortAuthors(item.authors)}</p><div className="discovery-actions"><a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">View record <ExternalLink size={14} /></a>{item.pdfUrl ? <button onClick={() => openPaperModal(item)}>Add to library <ArrowRight size={15} /></button> : <span className="no-pdf">No direct PDF link</span>}</div></div></article>)}</div></>}
          </div>}

          {view === 'library' && <div className="page-content">
            <div className="page-heading with-action"><div><span className="section-kicker">02 / READ</span><h1>Your paper library.</h1><p>A focused collection for {project?.title ?? 'this project'}, with original sources one click away.</p></div><button className="primary-action" onClick={() => openPaperModal()}><Plus size={17} /> Add PDF</button></div>
            <form className="library-toolbar" onSubmit={event => { event.preventDefault(); void loadPapers(projectId, undefined, librarySearch).catch(cause => reportError(cause, 'Could not search the library.')); }}><Search size={17} /><input aria-label="Find a paper in your library" placeholder="Find by title, author, or DOI" value={librarySearch} onChange={event => setLibrarySearch(event.target.value)} /><button>Find paper</button></form>
            {papers.length === 0 ? <div className="empty-state"><span><FolderOpen size={29} /></span><h2>Your reading list starts here.</h2><p>Discover open-access papers or add a public PDF link to index the first source.</p><button className="empty-action" onClick={() => navigate('discover')}>Discover papers <ArrowRight size={16} /></button></div> : <><div className="results-heading"><strong>{project?.paperCount ?? papers.length} papers in this project</strong><span>{nextCursor ? 'Showing the first page' : 'Select a paper for details'}</span></div><div className="library-layout"><div><div className="library-list">{papers.map(paper => <button className={`library-paper ${selectedPaperId === paper.documentId ? 'selected' : ''}`} key={paper.documentId} onClick={() => setSelectedPaperId(paper.documentId)}><span className="paper-badge"><FileText size={19} /></span><span className="library-paper-copy"><small>{paper.publicationYear ?? 'YEAR UNKNOWN'} {paper.doi ? ` · DOI ${paper.doi}` : ''}</small><strong>{paper.title}</strong><em>{shortAuthors(paper.authors)}</em></span><span className="page-count">{paper.totalPages} pages <ArrowRight size={16} /></span></button>)}</div>{nextCursor && <button className="load-more" onClick={() => void loadPapers(projectId, nextCursor, librarySearch)}><ChevronDown size={17} /> Load more papers</button>}</div><aside className="paper-detail"><span className="section-kicker">PAPER DETAILS</span>{selectedPaper ? <div className="selected-paper-detail"><h3>{selectedPaper.title}</h3><p>{shortAuthors(selectedPaper.authors)} · {selectedPaper.publicationYear ?? 'Year unknown'}</p><div className="detail-pair"><span>Pages</span><strong>{selectedPaper.totalPages}</strong></div><div className="detail-pair"><span>Searchable passages</span><strong>{selectedPaper.totalChunks}</strong></div>{selectedPaper.doi && <div className="detail-pair"><span>DOI</span><strong>{selectedPaper.doi}</strong></div>}<a className="source-button" href={selectedPaper.url} target="_blank" rel="noopener noreferrer">Read original PDF <ExternalLink size={16} /></a><button className="outline-button" onClick={() => { setScopePaperId(selectedPaper.documentId); navigate('ask'); }}>Ask about this paper <ArrowRight size={16} /></button></div> : <div className="paper-detail-empty"><FileText size={26} /><p>Select a paper to see its details and source link.</p></div>}</aside></div></>}
          </div>}

          {view === 'evidence' && <div className="page-content">
            <div className="page-heading"><span className="section-kicker">03 / CAPTURE</span><h1>Your evidence matrix.</h1><p>Saved passages stay connected to the original paper and page. Add your own interpretation beside each source.</p></div>
            <div className="matrix-banner"><ClipboardList size={19} /><span><strong>How to add evidence</strong><small>Search or ask your library, then save a relevant source passage with a note.</small></span><button onClick={() => navigate('ask')}>Find evidence <ArrowRight size={15} /></button></div>
            {evidence.length === 0 ? <div className="empty-state"><span><Bookmark size={28} /></span><h2>No evidence saved yet.</h2><p>Your matrix will help you compare findings, methods, and limitations across papers.</p></div> : <div className="evidence-table-wrap"><table className="evidence-table"><thead><tr><th>TYPE</th><th>SOURCE &amp; PASSAGE</th><th>YOUR NOTE</th><th /></tr></thead><tbody>{evidence.map(item => <tr key={item.evidenceId}><td><span className={`kind-tag ${item.kind}`}>{item.kind}</span></td><td><strong>{item.title}</strong><a href={sourceLink(item.url, item.pageNumber)} target="_blank" rel="noopener noreferrer">Page {item.pageNumber} <ExternalLink size={12} /></a><p>{item.quote}</p></td><td><p className="evidence-note">{item.note || 'No interpretation added yet.'}</p></td><td><button className="icon-action" aria-label={`Remove evidence from ${item.title}`} disabled={busy === `remove-${item.evidenceId}`} onClick={() => void removeEvidence(item)}><Trash2 size={16} /></button></td></tr>)}</tbody></table></div>}
          </div>}

          {view === 'ask' && <div className="page-content ask-page">
            <div className="page-heading"><span className="section-kicker">04 / SYNTHESIZE</span><h1>Ask your sources.</h1><p>Explore the papers you indexed. Every answer includes the passages used, so you can check the original pages.</p></div>
            <div className="ask-box">
              <label htmlFor="research-query">YOUR RESEARCH QUESTION</label>
              <textarea id="research-query" placeholder="What methods do these papers use, and what limitations do they report?" value={researchQuery} onChange={event => setResearchQuery(event.target.value)} rows={3} />
              <div className="ask-toolbar">
                <div className="scope-picker" ref={scopeRef}>
                  <button ref={scopeTriggerRef} type="button" className="scope-trigger" aria-label={`Search scope: ${selectedScopeTitle}`} title={selectedScopeTitle} aria-expanded={scopeOpen} aria-controls="scope-options" disabled={!papers.length} onClick={() => setScopeOpen(open => !open)}>
                    <FolderOpen size={15} />
                    <span>{selectedScopeTitle}</span>
                    <ChevronDown size={15} />
                  </button>
                  {scopeOpen && <div id="scope-options" className="scope-options" role="listbox" aria-label="Search scope">
                    <button type="button" role="option" aria-selected={!scopePaperId} onClick={() => { setScopePaperId(''); setScopeOpen(false); scopeTriggerRef.current?.focus(); }}>All papers in this project {!scopePaperId && <Check size={14} />}</button>
                    {papers.map(paper => <button type="button" role="option" aria-selected={scopePaperId === paper.documentId} key={paper.documentId} onClick={() => { setScopePaperId(paper.documentId); setScopeOpen(false); scopeTriggerRef.current?.focus(); }}>{paper.title} {scopePaperId === paper.documentId && <Check size={14} />}</button>)}
                  </div>}
                </div>
                <div className="ask-actions">
                  <button className="secondary-action" disabled={Boolean(busy) || !papers.length || researchQuery.trim().length < 2} onClick={() => void research('search')}>{busy === 'search' ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} Find passages</button>
                  <button className="primary-action" disabled={Boolean(busy) || !papers.length || researchQuery.trim().length < 2} onClick={() => void research('ask')}>{busy === 'ask' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Analyze sources</button>
                </div>
              </div>
            </div>
            {!papers.length && <div className="ask-hint"><FilePlus2 size={17} /> Add a paper to this project to start searching its content.</div>}
            {answer && <section className="answer-card"><div className="answer-label"><Sparkles size={16} /> SOURCE-GROUNDED SYNTHESIS</div><div className="markdown"><ReactMarkdown>{answer}</ReactMarkdown></div><p>Check the passages below before using any claim in your writing.</p></section>}
            {hits.length > 0 && <section className="sources-section"><div className="results-heading"><strong>{answer ? 'Sources used in this answer' : 'Relevant passages'}</strong><span>{hits.length} passages · open the source page to verify</span></div><div className="source-grid">{hits.map(renderHit)}</div></section>}
            {!answer && hits.length === 0 && papers.length > 0 && <div className="ask-examples"><span>START WITH A QUESTION</span>{['What methods do these papers use?', 'Where do the findings disagree?', 'What limitations are reported?'].map(question => <button key={question} onClick={() => setResearchQuery(question)}>{question} <ArrowUpRight size={14} /></button>)}</div>}
          </div>}
        </div>
      </main>

      {modal && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setModal(null); }}><div className="modal-card" role="dialog" aria-modal="true" aria-label={modal === 'paper' ? 'Add paper' : modal === 'evidence' ? 'Save evidence' : 'Research project'}><button className="modal-close" aria-label="Close dialog" disabled={Boolean(busy)} onClick={() => setModal(null)}><X size={20} /></button>
        {(modal === 'project' || modal === 'edit-project') && <form onSubmit={event => void saveProject(event)}><span className="modal-icon"><BookOpen size={23} /></span><span className="section-kicker">RESEARCH WORKSPACE</span><h2>{modal === 'project' ? 'Start a new project.' : 'Shape your project.'}</h2><p>Give your reading a focus. You can refine the question as your research develops.</p><label htmlFor="project-title">Project title</label><input id="project-title" value={projectTitle} onChange={event => setProjectTitle(event.target.value)} placeholder="e.g. AI in student feedback" required minLength={2} maxLength={120} autoFocus /><label htmlFor="project-question">Research question</label><textarea id="project-question" value={projectQuestion} onChange={event => setProjectQuestion(event.target.value)} placeholder="What are you trying to understand?" rows={3} maxLength={1000} />{error && <div className="modal-error" role="alert">{error}</div>}<button className="modal-submit" disabled={busy === 'project'}>{busy === 'project' ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} {modal === 'project' ? 'Create project' : 'Save project'}</button></form>}
        {modal === 'paper' && <form onSubmit={event => void indexPaper(event)}><span className="modal-icon"><FilePlus2 size={23} /></span><span className="section-kicker">ADD TO YOUR LIBRARY</span><h2>Index a research paper.</h2><p>Add a public PDF link. The paper is split into page-aware passages for searching and citation.</p><label htmlFor="paper-url">PDF URL <em>required</em></label><input id="paper-url" type="url" value={paperDraft.url} onChange={event => setPaperDraft({ ...paperDraft, url: event.target.value })} placeholder="https://example.org/paper.pdf" required autoFocus /><label htmlFor="paper-title">Paper title</label><input id="paper-title" value={paperDraft.title} onChange={event => setPaperDraft({ ...paperDraft, title: event.target.value })} placeholder="Taken from the PDF if left blank" /><div className="modal-two"><div><label htmlFor="paper-authors">Authors</label><input id="paper-authors" value={paperDraft.authors} onChange={event => setPaperDraft({ ...paperDraft, authors: event.target.value })} placeholder="Comma-separated" /></div><div><label htmlFor="paper-year">Year</label><input id="paper-year" type="number" min="1800" max="2100" value={paperDraft.publicationYear} onChange={event => setPaperDraft({ ...paperDraft, publicationYear: event.target.value })} placeholder="2025" /></div></div><label htmlFor="paper-doi">DOI <em>optional</em></label><input id="paper-doi" value={paperDraft.doi} onChange={event => setPaperDraft({ ...paperDraft, doi: event.target.value })} placeholder="10.xxxx/xxxxx" />{error && <div className="modal-error" role="alert">{error}</div>}<button className="modal-submit" disabled={busy === 'paper'}>{busy === 'paper' ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />} {busy === 'paper' ? 'Indexing paper...' : 'Add to library'}</button><small className="modal-footnote">Indexing takes longer for large papers and requires an OpenAI API key.</small></form>}
        {modal === 'evidence' && selectedHit && <form onSubmit={event => void saveEvidence(event)}><span className="modal-icon"><Bookmark size={23} /></span><span className="section-kicker">SOURCE NOTE</span><h2>Save this evidence.</h2><p className="evidence-source-title">{selectedHit.title} · p. {selectedHit.pageNumber}</p><blockquote>{selectedHit.text}</blockquote><label htmlFor="evidence-kind">Evidence type</label><select id="evidence-kind" value={evidenceKind} onChange={event => setEvidenceKind(event.target.value as typeof evidenceKind)}><option value="finding">Finding</option><option value="method">Method</option><option value="limitation">Limitation</option><option value="context">Context</option></select><label htmlFor="evidence-note">Your interpretation</label><textarea id="evidence-note" value={evidenceNote} onChange={event => setEvidenceNote(event.target.value)} placeholder="Why does this passage matter to your research question?" rows={3} maxLength={2000} />{error && <div className="modal-error" role="alert">{error}</div>}<button className="modal-submit" disabled={busy === 'evidence'}>{busy === 'evidence' ? <LoaderCircle className="spin" size={17} /> : <Bookmark size={17} />} Save to matrix</button></form>}
      </div></div>}
    </div>
  );
}
