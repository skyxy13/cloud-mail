<template>
  <div class="editor-box" :class="[showLoading ? 'editor-box-loading' : '', loadFailed ? 'editor-box-fallback' : '']">
    <loading class="loading" v-if="showLoading"/>
    <div class="editor-fallback-tip" v-if="loadFailed">{{ t('editorFallbackTip') }}</div>
    <textarea :class="loadFailed ? 'editor-fallback' : ''" style="outline: none" :id="editorId" ref="editorRef"
              v-model="fallbackContent" @input="onFallbackInput"></textarea>
  </div>
</template>

<script setup>
import {ref, onMounted, onBeforeUnmount, watch, nextTick, shallowRef, defineEmits, computed} from 'vue';
import loading from "@/components/loading/index.vue";
import {useI18n} from 'vue-i18n'
import {useUiStore} from '@/store/ui.js'
import {useSettingStore} from '@/store/setting.js'

defineExpose({
  clearEditor,
  focus,
  getContent
})

const props = defineProps({
  defValue: {
    type: String,
    default: ''
  },
  editorId: {
    type: String,
    default: () => `editor-${Date.now()}`
  }
});


const {locale, t} = useI18n()
const emit = defineEmits(['change','focus']);
const editor = shallowRef(null);
const isInitialized = ref(false);
const editorRef = ref(null);
const showLoading = ref(false);
// TinyMCE 加载/初始化失败时降级成纯文本框，避免整块编辑区点不动、写不了邮件
const loadFailed = ref(false);
const fallbackContent = ref('');
const uiStore = useUiStore();
const settingStore = useSettingStore();

onMounted(() => {
  initTinyMCE();
});

onBeforeUnmount(() => {
  destroyEditor();
});

watch(() => props.defValue, (newValue) => {
  if (loadFailed.value) {
    fallbackContent.value = newValue || '';
    return;
  }
  if (editor.value && editor.value.getContent() !== newValue) {
    editor.value.setContent(newValue);
  }
});

watch(() => [uiStore.dark, settingStore.lang], () => {
  destroyEditor();
  initEditor();
});

const language = computed(() => {
  if (locale.value === 'zh') {
    return 'zh_CN'
  }

  return 'en'
})

function clearEditor() {
  if (editor.value) {
    editor.value.setContent('');
  } else {
    fallbackContent.value = '';
  }
}

function onFallbackInput() {
  emit('change', fallbackContent.value, fallbackContent.value.replace(/<[^>]+>/g, ''));
}

function initTinyMCE() {
  if (window.tinymce) {
    initEditor();
    return;
  }

  showLoading.value = true;
  const script = document.createElement('script');
  script.src = '/tinymce/tinymce.min.js';
  script.onload = () => {
    try {
      initEditor();
    } catch (e) {
      console.warn('tinymce init failed:', e?.message);
      enableFallback();
    }
  };
  // 脚本被拦/404 时不能一直卡着，退化成纯文本框
  script.onerror = () => {
    console.warn('tinymce script failed to load');
    enableFallback();
  };
  document.head.appendChild(script);
  showLoading.value = false;
}

function enableFallback() {
  loadFailed.value = true;
  showLoading.value = false;
  fallbackContent.value = props.defValue || '';
}

function initEditor() {
  try {
    createEditor();
  } catch (e) {
    console.warn('tinymce init failed:', e?.message);
    enableFallback();
  }
}

function createEditor() {
  window.tinymce.init({
    selector: `#${props.editorId}`,
    statusbar: false,
    height: "100%",
    auto_focus: true,
    //relative_urls: false,  //阻止 img标签域名和网站域名相同 自动把链接转换相对路径
    //remove_script_host: false, // 阻止删除 URL 中的域名
    forced_root_block: 'div',
    skin: `${uiStore.dark ? 'oxide-dark' : 'oxide'}`,
    content_css: `/tinymce/css/index.css,${uiStore.dark ? 'dark' : 'default'}`,
    content_style: `:root {
         --scrollbar-track-color: ${uiStore.dark ? '#141414' : '#FFFFFF'};
         --scrollbar-thumb-color: ${uiStore.dark ? '#8D9095' : '#A8ABB2'};
    }`,
    plugins: 'link image advlist lists  emoticons fullscreen  table preview code',
    toolbar: 'bold emoticons forecolor backcolor italic fontsize | alignleft aligncenter alignright alignjustify | outdent indent |  bullist numlist | link image  | table code preview fullscreen',
    toolbar_mode: 'scrolling',
    font_size_formats: '8px 10px 12px 14px 16px 18px 24px 36px',
    emoticons_search: false,
    language: language.value,
    language_load: true,
    menubar: false,
    license_key: 'gpl',
    noneditable_class: 'mceNonEditable',
    setup: (ed) => {
      editor.value = ed;
      ed.on('init', () => {
        ed.setContent(props.defValue);
        isInitialized.value = true;
      });
      ed.on('input change', () => {
        const content = ed.getContent();
        const text = ed.getContent({format: 'text'});
        emit('change', content, text);
      });
      ed.on('focus', () => {
        emit('focus', focus);
      })
    },
    autofocus: true,
    branding: false,
    file_picker_types: 'image',
    image_dimensions: false,
    image_description: false,
    link_title: false,
    dialog_type: 'none',
    file_picker_callback: (callback, value, meta) => {
      const input = document.createElement('input');
      input.setAttribute('type', 'file');
      input.setAttribute('accept', 'image/*');

      input.addEventListener('change', async (e) => {
        let file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = () => {
          const id = 'blobid' + (new Date()).getTime();
          const blobCache = tinymce.activeEditor.editorUpload.blobCache;
          const base64 = reader.result.split(',')[1];
          const blobInfo = blobCache.create(id, file, base64);
          blobCache.add(blobInfo);

          callback(blobInfo.blobUri(), {title: file.name});
        }
        reader.readAsDataURL(file);
      });

      input.click();
    }
  });
}

function focus() {
  nextTick(() => {
    if (editor.value) {
      editor.value.focus()
    } else {
      editorRef.value?.focus?.()
    }
  })
}

function getContent() {
  if (editor.value) {
    return editor.value.getContent()
  }
  return fallbackContent.value || ''
}


function destroyEditor() {
  if (editor.value) {
    editor.value.destroy();
    editor.value = null;
  }
}
</script>

<style lang="scss" scoped>
.editor-box {
  height: 100%;
  width: 100%;
}

.loading {
  margin: auto;
}

.editor-box-loading {
  display: flex;
  align-items: center;
  justify-content: center;
}

:deep(.tox-tbtn.tox-tbtn--select.tox-tbtn--bespoke) {
  width: 80px !important;
}

:deep(.tox.tox-tinymce.tox-fullscreen) {
  padding-right: 15px;
  padding-left: 15px;
  padding-bottom: 15px;
  background: var(--el-bg-color);
  @media (max-width: 767px) {
    padding-right: 10px;
    padding-left: 10px;
    padding-bottom: 10px;
  }
}

:deep(.tox-tinymce) {
  border: none;
  border-radius: 0;
}

:deep(.tox-toolbar__group) {
  padding-left: 0 !important;
  margin: 0 !important;
}

:deep(.tox-tbtn) {
  margin: 0 !important;
}

:deep(.tox .tox-edit-area::before) {
  display: none;
}

/* TinyMCE 加载失败时的纯文本降级输入框：必须铺满整块区域，否则用户点正文区域没反应 */
.editor-box-fallback {
  display: flex;
  flex-direction: column;
}

.editor-fallback {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
}

.editor-fallback-tip {
  flex: 0 0 auto;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}

</style>
