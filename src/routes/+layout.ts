// Prerender the whole app as static HTML (required by adapter-static)
export const prerender = true;

// SPA-style client routing is fine; no trailing-slash surprises on static hosts
export const trailingSlash = 'always';