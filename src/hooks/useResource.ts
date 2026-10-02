import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from '../api';

export function useResource<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const requestId = useRef(0);
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await loaderRef.current();
      if (id === requestId.current) setData(result);
      return result;
    } catch (cause) {
      if (id === requestId.current) setError(message(cause));
      return undefined;
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => { requestId.current += 1; };
    // The caller supplies the request's data dependencies; loaderRef keeps its latest implementation.
  }, [reload, ...dependencies]);
  return { data, loading, error, reload, setData };
}
