# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.1.0] - 2026-04-03

### Added
- 跨平台 CLI 入口，支持 `claude-to-feishu start/stop/status/restart` 命令
- Phase 3 命令体系扩展，新增多条飞书 Bot 指令
- Phase 2 全链路集成测试（14 个测试用例）

### Fixed
- `queryStream` abort 时给用户返回友好提示，不再暴露内部错误信息
- BACKLOG 遗留缺陷批量修复（12 项）
- 部署前终审发现的 19 项缺陷（含 6 位专家评审意见）
- 普通消息路径接入权限网关（技术债 C2）

### Changed
- SDK Bridge 去重重构，消除冗余逻辑
- Handler 命令路由拆分，提升可维护性
- 删除历史兼容层，清理技术债
- 新增使用手册（`docs/USER_MANUAL.md`）及遗留清单（`docs/BACKLOG.md`）
