import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import desktopBuilderConfig, {
  applyLinuxSuidSandboxPermissions,
  resolveLinuxPackageTargets,
} from "../electron-builder.config.js";
import { resolveDesktopProductIdentity } from "../scripts/desktop-product-identity.mjs";

// Linux 打包目标契约：rpm 是 deb 之外的安装分发格式，不能改变既有更新链路。
// latest.yml / electron-updater 在 Linux 上固定以 AppImage 作为更新产物，
// scripts/upload-oss.sh 也按 AppImage 解析更新元数据，因此 AppImage 必须保留。
describe("electron-builder Linux 打包目标", () => {
  it("prerelease 也生成统一的 latest.yml", () => {
    expect(desktopBuilderConfig.detectUpdateChannel).toBe(false);
  });

  it("具备 rpmbuild 的构建机产出完整的 AppImage、deb、rpm 与 pacman 安装包", () => {
    // 完整分发矩阵是发布契约：AppImage 承担 Linux 自动更新（latest.yml 按 AppImage 解析），
    // rpm/pacman 分别服务 RHEL 与 Arch 用户。构建机具备 rpmbuild 时四件套必须齐全。
    const targets = resolveLinuxPackageTargets({
      hasRpmbuild: () => true,
      hasBsdtar: () => true,
    });

    expect(targets).toContain("AppImage");
    expect(targets).toContain("deb");
    expect(targets).toContain("rpm");
    expect(targets).toContain("pacman");
  });

  it("deb 系构建机（无 rpmbuild）自动跳过 rpm 且保留其余目标", () => {
    // Debian/Ubuntu 构建机默认没有 rpmbuild，rpm 阶段会失败并中断后续目标；
    // 此时降级为 AppImage + deb + pacman，更新链路（AppImage）不受影响。
    const targets = resolveLinuxPackageTargets({
      hasRpmbuild: () => false,
      hasBsdtar: () => true,
    });

    expect(targets).not.toContain("rpm");
    expect(targets).toContain("AppImage");
    expect(targets).toContain("deb");
    expect(targets).toContain("pacman");
  });

  it("无 bsdtar 的构建机自动跳过 pacman", () => {
    // pacman 目标需要 bsdtar 生成 .MTREE，deb 系构建机默认没有；
    // 缺工具时跳过 pacman，避免打包链路中断。
    const targets = resolveLinuxPackageTargets({
      hasRpmbuild: () => true,
      hasBsdtar: () => false,
    });

    expect(targets).not.toContain("pacman");
    expect(targets).toContain("AppImage");
    expect(targets).toContain("deb");
    expect(targets).toContain("rpm");
  });

  it("rpm 与 pacman 工具都缺失时只保留 AppImage 与 deb", () => {
    const targets = resolveLinuxPackageTargets({
      hasRpmbuild: () => false,
      hasBsdtar: () => false,
    });

    expect(targets).toEqual(["AppImage", "deb"]);
  });

  it("rpm 与 deb 的 packageName 按 flavor 拆分且保持一致", () => {
    // 生产版与 Preview 必须是两个独立系统包：rpm 若复用默认包名，
    // dnf 会把另一 flavor 的安装当成升级替换，与 deb 的 packageName 约束对齐。
    const identity = resolveDesktopProductIdentity();

    expect(desktopBuilderConfig.rpm?.packageName).toBe(identity.linuxPackageName);
    expect(desktopBuilderConfig.deb?.packageName).toBe(identity.linuxPackageName);
    expect(desktopBuilderConfig.pacman?.packageName).toBe(identity.linuxPackageName);
  });

  it("rpm 通过 fpm 追加 Electron 实际需要的运行库 Requires", () => {
    // electron-builder 的 rpm 默认 Requires 不含 mesa-libgbm / alsa-lib（Electron ELF 的
    // DT_NEEDED 实际依赖），最小化 RHEL 上装完会启动失败；必须以 fpm -d 追加而不是
    // depends 整组替换默认 Requires。
    expect(desktopBuilderConfig.rpm?.fpm).toContain("mesa-libgbm");
    expect(desktopBuilderConfig.rpm?.fpm).toContain("alsa-lib");
    expect(desktopBuilderConfig.rpm?.fpm).toContain("-d");
  });

  it("pacman 使用 Arch 原生 .pkg.tar.zst 扩展名", () => {
    expect(desktopBuilderConfig.pacman?.artifactName).toContain(".pkg.tar.zst");
  });

  it("pacman 显式声明 Electron 启动所需的 Arch 运行库", () => {
    const dependencies = desktopBuilderConfig.pacman?.depends ?? [];

    // 显式依赖必须使用 Arch 官方仓库中的包名，避免 electron-builder 时代久远的
    // 默认集合引入已移除的 libappindicator-gtk3/http-parser 等包导致 pacman -U 失败。
    expect(dependencies).toEqual([
      "gtk3",
      "nss",
      "libxss",
      "libxtst",
      "libnotify",
      "alsa-lib",
      "mesa",
      "xdg-utils",
    ]);
  });

  it("pacman 不显式覆盖 electron-builder 的默认压缩格式", () => {
    // electron-builder 26.8.1 的 pacman 默认产物就是 zstd；显式填写 zstd 会被其
    // 配置 schema 拒绝，因此只约束扩展名，不在配置中覆盖默认压缩格式。
    expect(desktopBuilderConfig.pacman?.compression).toBeUndefined();
  });

  it("Linux 打包后为 chrome-sandbox 预置 SUID 沙箱权限", () => {
    // Ubuntu 23.10+ 通过 AppArmor 收紧 unprivileged userns，Electron 回退到 SUID helper
    // 沙箱模式；chrome-sandbox 必须是 4755。打包时预置后，deb 由 dpkg 以 root 解包即满足
    // 要求；非 Linux 平台不改动权限。
    const appOutDir = mkdtempSync(join(tmpdir(), "zcode-chrome-sandbox-test-"));
    try {
      const sandboxPath = join(appOutDir, "chrome-sandbox");
      writeFileSync(sandboxPath, "");
      chmodSync(sandboxPath, 0o755);

      applyLinuxSuidSandboxPermissions({ electronPlatformName: "linux", appOutDir });
      expect(statSync(sandboxPath).mode & 0o7777).toBe(0o4755);

      chmodSync(sandboxPath, 0o755);
      applyLinuxSuidSandboxPermissions({ electronPlatformName: "darwin", appOutDir });
      expect(statSync(sandboxPath).mode & 0o7777).toBe(0o755);
    } finally {
      rmSync(appOutDir, { recursive: true, force: true });
    }
  });
});
