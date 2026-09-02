import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import type { AppRouter } from "../../../server/src/router.js";

export const trpc = createTRPCReact<AppRouter>();

export const queryClient = new QueryClient({
  // 统一保证所有写操作完成后，当前页面立即读取服务端真值。
  // 这样即使某个 mutation 忘了单独 invalidate，也不会要求用户手动刷新网页。
  mutationCache: new MutationCache({
    onSuccess: async (_data, _variables, _context, mutation) => {
      if (mutation.meta?.skipGlobalRefetch === true) return;
      // invalidate 在 staleTime=Infinity 的 query 上只标记过期；直接 refetch
      // 保证写操作完成后当前页面马上读到服务端真值。
      await queryClient.refetchQueries({ type: "active" });
    }
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      // 默认 30s 内视为新鲜：切 workspace tab / 重挂组件不会立即重 fetch、
      // 也不会因为 data 短暂为 undefined 而误显示"未配置"假阳性。
      // 真正需要实时刷新的 query 用自己的 refetchInterval 覆盖（statusSnapshot 5s / jobs 3s 等）。
      staleTime: 30_000
    }
  }
});

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/trpc"
    })
  ]
});
