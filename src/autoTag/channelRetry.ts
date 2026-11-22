/**
 * 分通道独立重试。
 *
 * 双通道是两条互相独立的请求:状态表挂了不该拖累导演,导演偶发超时也不该把
 * 已经填好的服装表一起丢掉。所以重试必须落在「每条通道内部」,而不是包在
 * 两路外面共用一个 try。
 */

export interface ChannelRetryOptions {
  /** 额外重试次数:0 = 只发一次。 */
  retries: number;
  signal: AbortSignal;
  /** 日志与请求来源标签,例如「镜头导演(第 3 楼)」。 */
  source: string;
  /** 每次失败后的回调(默认 console.warn)。 */
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function runChannelWithRetries<T>(
  dispatch: (opts: { signal: AbortSignal; source: string }) => Promise<T>,
  options: ChannelRetryOptions,
): Promise<T> {
  const retries = Math.max(0, Math.floor(Number(options.retries) || 0));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal.aborted) throw new Error('已取消');
    try {
      const source = retries > 0 ? `${options.source} · 第 ${attempt + 1} 次` : options.source;
      return await dispatch({ signal: options.signal, source });
    } catch (error) {
      lastError = error;
      if (options.onRetry) options.onRetry(error, attempt + 1);
      else if (retries > 0) console.warn(`[星绘] ${options.source}第 ${attempt + 1} 次失败`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}