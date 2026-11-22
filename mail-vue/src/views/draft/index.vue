<template>
  <emailScroll ref="scroll"
               :allow-star="false"
               :getEmailList="getEmailList"
               :emailDelete="emailDelete"
               :star-add="starAdd"
               :star-cancel="starCancel"
               @jump="jumpContent"
               actionLeft="6px"
               :show-account-icon="false"
               :show-first-loading="false"
               :showStar="false"
               @delete-draft="deleteDraft"
               :type="'draft'"
  >
    <template #name="props">
      <span class="send-email">{{ props.email.receiveEmail?.join(',') || '(' + $t('noRecipient') + ')' }}</span>
    </template>
    <template #subject="props">
      {{ props.email.subject || '(' + $t('noSubject') + ')' }}
    </template>
  </emailScroll>
</template>

<script setup>
import emailScroll from "@/components/email-scroll/index.vue"
import {emailDelete} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, ref, watch, toRaw} from "vue";
import {useUiStore} from "@/store/ui.js";
import {userDraftStore} from "@/store/draft.js";
import db from "@/db/db.js"
import {draftList, draftDelete} from "@/request/draft.js"

defineOptions({
  name: 'draft'
})

const draftStore = userDraftStore();
const uiStore = useUiStore();
const scroll = ref({})

watch(() => draftStore.setDraft, async () => {

  const draft = toRaw(draftStore.setDraft)
  const draftId = draft.draftId
  const attachments = toRaw(draftStore.setDraft.attachments)

  delete draft.draftId
  delete draft.attachments

  if (!draft.content && !draft.subject && !(draft.receiveEmail.length > 0)) {
    await db.value.draft.delete(draftId);
    await db.value.att.delete(draftId);
    draftStore.refreshList++
    return;
  }

  await db.value.draft.update(draftId, draft);
  await db.value.att.update(draftId, {attachments: attachments});
  draftStore.refreshList++
}, {
  deep: true
})

watch(() => draftStore.refreshList, async () => {
  const {list} = await getEmailList();
    scroll.value.emailList.length = 0
    scroll.value.handleList(list);
    scroll.value.emailList.push(...list)
})

// 本地草稿（含附件）+ 服务端草稿（跨设备，无附件）合并展示
function getEmailList() {
  return new Promise((resolve) => {
    Promise.all([
      db.value.draft.orderBy('createTime').reverse().toArray(),
      draftList().catch(() => [])
    ]).then(([local, remote]) => {
      const syncedIds = new Set(local.map(item => item.serverId).filter(Boolean))
      const remoteList = (remote || [])
        .filter(item => !syncedIds.has(item.draftId))
        .map(item => ({
          draftId: 's' + item.draftId,
          serverId: item.draftId,
          remote: true,
          receiveEmail: item.receiveEmail || [],
          ccEmail: item.ccEmail || [],
          bccEmail: item.bccEmail || [],
          subject: item.subject || '',
          content: item.content || '',
          text: item.text || '',
          replyTo: item.replyTo || '',
          sendEmail: item.sendEmail || '',
          accountId: item.accountId,
          name: item.name || '',
          manyType: item.manyType || 'together',
          createTime: item.updateTime || item.createTime || ''
        }))

      const list = [...local, ...remoteList]
        .sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')))
      resolve({list})
    })
  })
}

async function deleteDraft(draftIds) {
  const localIds = []
  const serverIds = []
  draftIds.forEach(id => {
    if (typeof id === 'string' && id.startsWith('s')) {
      serverIds.push(id.slice(1))
    } else {
      localIds.push(id)
    }
  })

  if (localIds.length > 0) {
    await db.value.draft.bulkDelete(localIds);
  }
  if (serverIds.length > 0) {
    await draftDelete(serverIds.join(','))
  }
  draftStore.refreshList++
}

async function jumpContent(email) {
  if (email.remote) {
    email.attachments = []
  } else {
    const att = await db.value.att.get(email.draftId)
    email.attachments = att?.attachments || []
  }
  uiStore.writerRef.openDraft(email);
}

</script>
<style>
.send-email {
  font-weight: normal;
}
</style>
