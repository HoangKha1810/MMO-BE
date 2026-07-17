CREATE TABLE IF NOT EXISTS `vps_store_settings` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `setting_key` varchar(100) NOT NULL,
  `setting_value` text DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_vps_store_settings_key` (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vps_remote_products` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `vncloud_product_id` bigint NOT NULL,
  `name` varchar(255) NOT NULL,
  `slug` varchar(255) NOT NULL,
  `category` varchar(120) DEFAULT 'VPS VN',
  `region` varchar(120) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `cpu_label` varchar(100) DEFAULT NULL,
  `ram_label` varchar(100) DEFAULT NULL,
  `disk_label` varchar(100) DEFAULT NULL,
  `bandwidth_label` varchar(100) DEFAULT NULL,
  `base_price` decimal(15,2) DEFAULT 0.00,
  `raw_payload` longtext NOT NULL,
  `synced_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_vps_remote_products_product` (`vncloud_product_id`),
  KEY `idx_vps_remote_products_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vps_remote_operating_systems` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `vncloud_os_id` int NOT NULL,
  `name` varchar(150) NOT NULL,
  `slug` varchar(150) NOT NULL,
  `group_name` varchar(100) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `raw_payload` longtext NOT NULL,
  `synced_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_vps_remote_os_id` (`vncloud_os_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vps_remote_billing_cycles` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `cycle_code` varchar(50) NOT NULL,
  `label` varchar(100) NOT NULL,
  `months` int NOT NULL DEFAULT 1,
  `raw_payload` longtext NOT NULL,
  `synced_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_vps_remote_cycle_code` (`cycle_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vps_catalog_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `sku` varchar(60) NOT NULL,
  `title` varchar(255) NOT NULL,
  `slug` varchar(255) NOT NULL,
  `short_description` varchar(255) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `vncloud_product_id` bigint NOT NULL,
  `vncloud_os_id` int NOT NULL,
  `billing_cycle_code` varchar(50) NOT NULL,
  `sale_price` decimal(15,2) NOT NULL,
  `compare_price` decimal(15,2) DEFAULT NULL,
  `addon_cpu` int NOT NULL DEFAULT 0,
  `addon_ram` int NOT NULL DEFAULT 0,
  `addon_disk` int NOT NULL DEFAULT 0,
  `badge_text` varchar(80) DEFAULT NULL,
  `hero_gradient_from` varchar(20) NOT NULL DEFAULT '#0f766e',
  `hero_gradient_to` varchar(20) NOT NULL DEFAULT '#2563eb',
  `sort_order` int NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_featured` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_vps_catalog_items_sku` (`sku`),
  UNIQUE KEY `uniq_vps_catalog_items_slug` (`slug`),
  KEY `idx_vps_catalog_items_active_order` (`is_active`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vps_orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_code` varchar(50) NOT NULL,
  `user_id` int NOT NULL,
  `catalog_item_id` bigint unsigned NOT NULL,
  `vncloud_product_id` bigint NOT NULL,
  `billing_cycle_code` varchar(50) NOT NULL,
  `vncloud_os_id` int NOT NULL,
  `quantity` int NOT NULL DEFAULT 1,
  `addon_cpu` int NOT NULL DEFAULT 0,
  `addon_ram` int NOT NULL DEFAULT 0,
  `addon_disk` int NOT NULL DEFAULT 0,
  `unit_price` decimal(15,2) NOT NULL,
  `total_price` decimal(15,2) NOT NULL,
  `status` enum('pending','processing','provisioning','active','failed','refund_requested','refunded','cancelled') NOT NULL DEFAULT 'pending',
  `buyer_note` text DEFAULT NULL,
  `failure_reason` text DEFAULT NULL,
  `refund_requested_at` datetime DEFAULT NULL,
  `refund_amount` decimal(15,2) DEFAULT NULL,
  `refunded_at` datetime DEFAULT NULL,
  `agency_credit_after` decimal(15,2) DEFAULT NULL,
  `vncloud_response` longtext DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_vps_orders_code` (`order_code`),
  KEY `idx_vps_orders_user_status` (`user_id`,`status`),
  KEY `idx_vps_orders_catalog` (`catalog_item_id`),
  CONSTRAINT `fk_vps_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_vps_orders_catalog_item` FOREIGN KEY (`catalog_item_id`) REFERENCES `vps_catalog_items` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vps_instances` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint unsigned NOT NULL,
  `user_id` int NOT NULL,
  `vncloud_vps_id` bigint NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `ip_address` varchar(64) DEFAULT NULL,
  `username` varchar(191) DEFAULT NULL,
  `password` varchar(191) DEFAULT NULL,
  `status` varchar(60) NOT NULL DEFAULT 'progressing',
  `next_due_date` datetime DEFAULT NULL,
  `is_special` tinyint(1) NOT NULL DEFAULT 0,
  `auto_renew` tinyint(1) NOT NULL DEFAULT 0,
  `raw_payload` longtext DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_vps_instances_vncloud_id` (`vncloud_vps_id`),
  KEY `idx_vps_instances_user_status` (`user_id`,`status`),
  KEY `idx_vps_instances_order` (`order_id`),
  CONSTRAINT `fk_vps_instances_order` FOREIGN KEY (`order_id`) REFERENCES `vps_orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_vps_instances_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vps_instance_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `vps_instance_id` bigint unsigned NOT NULL,
  `user_id` int DEFAULT NULL,
  `action` varchar(80) NOT NULL,
  `status` varchar(30) NOT NULL DEFAULT 'success',
  `message` text DEFAULT NULL,
  `payload` longtext DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_vps_instance_logs_instance` (`vps_instance_id`),
  CONSTRAINT `fk_vps_instance_logs_instance` FOREIGN KEY (`vps_instance_id`) REFERENCES `vps_instances` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `admin_audit_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `target_user_id` int DEFAULT NULL,
  `action` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `ip_address` varchar(64) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_admin_audit_logs_admin` (`admin_id`),
  KEY `idx_admin_audit_logs_target_user` (`target_user_id`),
  CONSTRAINT `fk_admin_audit_logs_admin` FOREIGN KEY (`admin_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_audit_logs_target_user` FOREIGN KEY (`target_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `vps_store_settings` (`setting_key`, `setting_value`)
VALUES
  ('brand_name', 'TRUNGTAMMMO.VN'),
  ('hero_title', 'Thuê VPS tốc độ cao, quản lý dễ dàng tại TRUNGTAMMMO.VN'),
  ('hero_subtitle', 'Bảng giá rõ ràng, kích hoạt nhanh, giao diện mượt và khu quản lý máy chủ tập trung cho từng tài khoản.'),
  ('hero_badge', 'Hệ thống VPS tự động'),
  ('support_link', 'https://zalo.me/3482369546728805278'),
  ('announcement', 'Danh mục VPS, giá bán và tình trạng máy chủ đều có thể quản lý tập trung trên một giao diện.'),
  ('theme_default', 'dark'),
  ('intro_customer_count', '16890'),
  ('addon_cpu_price', '15000'),
  ('addon_ram_price', '15000'),
  ('addon_disk_price', '5000'),
  ('addon_disk_step', '10')
ON DUPLICATE KEY UPDATE
  `setting_value` = VALUES(`setting_value`);
