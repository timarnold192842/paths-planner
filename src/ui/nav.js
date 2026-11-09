// Hash routing: #/overview, #/compare, #/scenarios, #/decisions, #/plan/flows, #/settings
import { useEffect, useState } from 'preact/hooks';

export function navigate(route) {
  location.hash = `#/${route}`;
  window.scrollTo({ top: 0 });
}

export function useRoute() {
  const read = () => (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
