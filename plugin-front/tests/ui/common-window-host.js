// 仅供模拟宿主预览：生产代码始终使用 window.api 暴露的通用窗口组件。
export function installCommonWindowHost(Vue) {
  const native = window.api.isElectron;
  window.api.PlatformModal = Vue.defineComponent({
    props: ["visible", "title", "width", "height"],
    emits: ["cancel"],
    setup(props, { slots, emit, attrs }) {
      return () =>
        props.visible
          ? Vue.h(
              "section",
              {
                ...attrs,
                "data-common-window": "",
                style: native
                  ? "position:fixed;inset:0;background:white;display:flex;flex-direction:column"
                  : `position:fixed;left:50%;top:30px;transform:translateX(-50%);width:${props.width}px;height:min(${props.height}px,90vh);z-index:2500;background:white;border:1px solid #d7dbe3;display:flex;flex-direction:column;box-shadow:0 10px 32px #0002`
              },
              [
                Vue.h(
                  "header",
                  { style: "display:flex;align-items:center;height:28px;flex-shrink:0;border-bottom:1px solid #ddd;padding:0 12px" },
                  [
                    Vue.h("span", { style: "flex:1" }, props.title),
                    slots["title-center"]?.(),
                    Vue.h("button", { "aria-label": "关闭通用窗口", onClick: () => emit("cancel") }, "×")
                  ]
                ),
                Vue.h("div", { class: "c-platform-modal--content", style: "flex:1;min-height:0" }, slots.default?.())
              ]
            )
          : null;
    }
  });
  window.api.usePlatformModalUtil = emit => {
    const visible = Vue.ref(false);
    Vue.onMounted(() => {
      visible.value = true;
    });
    const close = () => {
      if (native) window.require("electron").ipcRenderer.send("WindowClose", { windowName: "AgentAssistantWindow", success: true });
      else {
        visible.value = false;
        emit("sure", { success: true });
      }
    };
    return { visible, handleOk: close, handleCancel: close };
  };
  // 浏览器端模拟 Portal 的组件装配和 sure/close 生命周期。
  window.api.IpcWindow = class {
    constructor(name) {
      this.name = name;
    }
    async popup(query) {
      if (native) throw new Error("Electron 验证需注入真实宿主 IpcWindow 类");
      const { default: Component } = await import("/src/components/modals/assistantWindow/index.vue");
      const container = document.createElement("div");
      document.body.appendChild(container);
      return new Promise(resolve => {
        const close = data => {
          resolve(data);
          setTimeout(() => {
            instance.unmount();
            container.remove();
          }, 300);
        };
        const instance = Vue.createApp({ render: () => Vue.h(Component, { ...query, onSure: close, onClose: close }) });
        instance.mount(container);
      });
    }
    done() {}
  };
}
