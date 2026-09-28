type OpenAlexWork = {
  id?: string;
  title?: string;
  publication_year?: number;
  doi?: string;
  authorships?: { author?: { display_name?: string } }[];
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  primary_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
};

function publicLink(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function discoverPapers(query: string) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('filter', 'open_access.is_oa:true');
  url.searchParams.set('per_page', '12');
  const key = process.env.OPENALEX_API_KEY;
  if (key) url.searchParams.set('api_key', key);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`OpenAlex returned ${response.status}`);
  const data = await response.json() as { results?: OpenAlexWork[] };
  return (data.results ?? []).map(work => ({
    openalexId: work.id ?? '',
    title: work.title ?? 'Untitled work',
    publicationYear: work.publication_year ?? null,
    doi: work.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') ?? null,
    authors: (work.authorships ?? []).slice(0, 8)
      .map(entry => entry.author?.display_name).filter((name): name is string => Boolean(name)),
    pdfUrl: publicLink(work.best_oa_location?.pdf_url ?? work.primary_location?.pdf_url),
    sourceUrl: publicLink(work.best_oa_location?.landing_page_url ?? work.primary_location?.landing_page_url ?? work.id) ?? '',
  }));
}
