// 键盘输入（星露谷式）：WASD/方向键移动、E 交互、Esc/Tab 菜单。
// 单一输入源（引擎持有 window 监听）；菜单开关时引擎 setPaused，避免与 React 抢按键。
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>(); // 本帧刚按下（边沿，用于 E/Esc 这种触发式）
  private attached = false;
  private paused = false; // 菜单打开时：仍追踪按键(供 Esc 关菜单)，但不再 preventDefault 移动键，放行菜单内输入框

  setPaused(p: boolean) {
    this.paused = p;
    if (p) this.held.clear(); // 暂停瞬间清掉按住态，避免恢复时角色“惯性走一步”
  }

  attach() {
    if (this.attached) return;
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
    this.attached = true;
  }
  detach() {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.attached = false;
  }

  private onDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!this.held.has(k)) this.pressed.add(k);
    this.held.add(k);
    // 防止方向键/空格滚动页面、Tab 切焦点。菜单打开(paused)时放行，让菜单内输入框正常工作。
    if (!this.paused && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'tab'].includes(k)) e.preventDefault();
  };
  private onUp = (e: KeyboardEvent) => {
    this.held.delete(e.key.toLowerCase());
  };
  private onBlur = () => {
    this.held.clear(); // 失焦清空，避免“按住时切窗口”导致角色一直走
  };

  isDown(...keys: string[]): boolean {
    return keys.some((k) => this.held.has(k));
  }
  wasPressed(...keys: string[]): boolean {
    return keys.some((k) => this.pressed.has(k));
  }
  /** 每帧末清边沿集合 */
  endFrame() {
    this.pressed.clear();
  }
}
