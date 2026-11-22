import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// 发件服务相关测试：服务商请求体（node 侧）与配置读写（workerd + 本地 D1）
export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				singleWorker: true,
				isolatedStorage: false,
				wrangler: { configPath: './wrangler-vitest.toml' }
			}
		},
		include: ['test/send-provider.spec.js', 'test/setting-provider.worker.spec.js']
	}
});
