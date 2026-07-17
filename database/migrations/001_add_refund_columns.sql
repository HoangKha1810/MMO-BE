-- Migration: Add refund columns to vps_orders table
-- Run this if you already have existing database

ALTER TABLE `vps_orders`
  ADD COLUMN IF NOT EXISTS `refund_requested_at` datetime DEFAULT NULL AFTER `failure_reason`,
  ADD COLUMN IF NOT EXISTS `refund_amount` decimal(15,2) DEFAULT NULL AFTER `refund_requested_at`,
  ADD COLUMN IF NOT EXISTS `refunded_at` datetime DEFAULT NULL AFTER `refund_amount`;

-- Update enum to include refund_requested status
ALTER TABLE `vps_orders`
  MODIFY COLUMN `status` enum('pending','processing','provisioning','active','failed','refund_requested','refunded','cancelled') NOT NULL DEFAULT 'pending';
