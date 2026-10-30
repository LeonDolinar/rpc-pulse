CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`schedule_id` text,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_created_idx` ON `benchmark_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `benchmark_runs` (`status`);--> statement-breakpoint
CREATE TABLE `endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`network_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`url_ciphertext` text NOT NULL,
	`url_redacted` text NOT NULL,
	`host` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `endpoints_network_idx` ON `endpoints` (`network_id`);--> statement-breakpoint
CREATE TABLE `networks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`chain_id` integer,
	`is_testnet` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `networks_slug_unique` ON `networks` (`slug`);--> statement-breakpoint
CREATE TABLE `request_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`run_endpoint_id` text NOT NULL,
	`method` text NOT NULL,
	`started_at` real NOT NULL,
	`ttfb_ms` real,
	`total_ms` real NOT NULL,
	`ok` integer NOT NULL,
	`error_type` text,
	`http_status` integer,
	`rpc_error_code` integer,
	`error_message` text,
	`block_number` integer,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_endpoint_id`) REFERENCES `run_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `samples_run_endpoint_idx` ON `request_samples` (`run_endpoint_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `samples_started_idx` ON `request_samples` (`started_at`);--> statement-breakpoint
CREATE TABLE `run_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`endpoint_id` text,
	`position` integer NOT NULL,
	`endpoint_name` text NOT NULL,
	`provider` text NOT NULL,
	`network_id` text NOT NULL,
	`network_name` text NOT NULL,
	`expected_chain_id` integer,
	`url_redacted` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`window_ms` real,
	`total` integer DEFAULT 0 NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`success_rate` real,
	`throughput_rps` real,
	`success_rps` real,
	`latency_mean` real,
	`latency_p50` real,
	`latency_p95` real,
	`latency_p99` real,
	`latency` text,
	`ttfb` text,
	`network_rtt_ms` real,
	`provider_time_ms` real,
	`errors` text DEFAULT '{}' NOT NULL,
	`observed_chain_id` integer,
	`client_version` text,
	`head_block` integer,
	`block_lag` integer,
	`issues` text DEFAULT '[]' NOT NULL,
	`methods` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `run_endpoints_run_idx` ON `run_endpoints` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_endpoints_endpoint_idx` ON `run_endpoints` (`endpoint_id`,`finished_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`interval_sec` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
