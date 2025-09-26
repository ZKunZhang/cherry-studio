import { loggerService } from '@logger'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { RichEditorRef } from '@renderer/components/RichEditor/types'
import { useActiveNode, useFileContent, useFileContentSync } from '@renderer/hooks/useNotesQuery'
import { useNotesSettings } from '@renderer/hooks/useNotesSettings'
import { useShowWorkspace } from '@renderer/hooks/useShowWorkspace'
import {
  createFolder,
  createNote,
  deleteNode,
  initWorkSpace,
  moveNode,
  renameNode,
  sortAllLevels,
  uploadFiles
} from '@renderer/services/NotesService'
import { getNotesTree, isParentNode, updateNodeInTree } from '@renderer/services/NotesTreeService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectActiveFilePath, selectSortType, setActiveFilePath, setSortType } from '@renderer/store/note'
import { NotesSortType, NotesTreeNode } from '@renderer/types/note'
import { FileChangeEvent } from '@shared/config/types'
import { useLiveQuery } from 'dexie-react-hooks'
import { debounce } from 'lodash'
import { AnimatePresence, motion } from 'motion/react'
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import HeaderNavbar from './HeaderNavbar'
import NotesEditor from './NotesEditor'
import NotesSidebar from './NotesSidebar'

const logger = loggerService.withContext('NotesPage')

const NotesPage: FC = () => {
  const editorRef = useRef<RichEditorRef>(null)
  const { t } = useTranslation()
  const { showWorkspace } = useShowWorkspace()
  const dispatch = useAppDispatch()
  const activeFilePath = useAppSelector(selectActiveFilePath)
  const sortType = useAppSelector(selectSortType)
  const { settings, notesPath, updateNotesPath } = useNotesSettings()

  // 混合策略：useLiveQuery用于笔记树，React Query用于文件内容
  const notesTreeQuery = useLiveQuery(() => getNotesTree(), [])
  const notesTree = useMemo(() => notesTreeQuery || [], [notesTreeQuery])
  const { activeNode } = useActiveNode(notesTree)
  const { invalidateFileContent } = useFileContentSync()
  const { data: currentContent = '', isLoading: isContentLoading } = useFileContent(activeFilePath)

  const [tokenCount, setTokenCount] = useState(0)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const watcherRef = useRef<(() => void) | null>(null)
  const isSyncingTreeRef = useRef(false)
  const lastContentRef = useRef<string>('')
  const lastFilePathRef = useRef<string | undefined>(undefined)
  const isInitialSortApplied = useRef(false)
  // Operation state management - unified tracking of operations that may interfere with file watching
  const pendingOperationsRef = useRef(new Set<string>())

  // Operation manager utility functions - use useMemo to ensure stable reference
  const operationManager = useMemo(() => {
    const addOperation = (operationId: string) => {
      pendingOperationsRef.current.add(operationId)
      logger.debug('Operation started:', { operationId, totalOperations: pendingOperationsRef.current.size })
    }

    const removeOperation = (operationId: string) => {
      pendingOperationsRef.current.delete(operationId)
      logger.debug('Operation completed:', { operationId, totalOperations: pendingOperationsRef.current.size })
    }

    const hasPendingOperations = () => pendingOperationsRef.current.size > 0

    const withOperation = async <T extends unknown>(operationId: string, operation: () => Promise<T>): Promise<T> => {
      addOperation(operationId)
      try {
        return await operation()
      } finally {
        removeOperation(operationId)
      }
    }

    return { addOperation, removeOperation, hasPendingOperations, withOperation }
  }, []) // Empty dependency array since all references are stable

  useEffect(() => {
    const updateCharCount = () => {
      const textContent = editorRef.current?.getContent() || currentContent
      const plainText = textContent.replace(/<[^>]*>/g, '')
      setTokenCount(plainText.length)
    }
    updateCharCount()
  }, [currentContent])

  // 查找树节点 by ID
  const findNodeById = useCallback((tree: NotesTreeNode[], nodeId: string): NotesTreeNode | null => {
    for (const node of tree) {
      if (node.id === nodeId) {
        return node
      }
      if (node.children) {
        const found = findNodeById(node.children, nodeId)
        if (found) return found
      }
    }
    return null
  }, [])

  // 保存当前笔记内容
  const saveCurrentNote = useCallback(
    async (content: string, filePath?: string) => {
      const targetPath = filePath || activeFilePath
      if (!targetPath || content.trim() === currentContent.trim()) return

      try {
        await window.api.file.write(targetPath, content)
        // 保存后立即刷新缓存，确保下次读取时获取最新内容
        invalidateFileContent(targetPath)
      } catch (error) {
        logger.error('Failed to save note:', error as Error)
      }
    },
    [activeFilePath, currentContent, invalidateFileContent]
  )

  // 防抖保存函数，在停止输入后才保存，避免输入过程中的文件写入
  const debouncedSave = useMemo(
    () =>
      debounce((content: string, filePath: string | undefined) => {
        saveCurrentNote(content, filePath)
      }, 800), // 800ms防抖延迟
    [saveCurrentNote]
  )

  const handleMarkdownChange = useCallback(
    (newMarkdown: string) => {
      // 记录最新内容和文件路径，用于兜底保存
      lastContentRef.current = newMarkdown
      lastFilePathRef.current = activeFilePath
      // 捕获当前文件路径，避免在防抖执行时文件路径已改变的竞态条件
      debouncedSave(newMarkdown, activeFilePath)
    },
    [debouncedSave, activeFilePath]
  )

  useEffect(() => {
    async function initialize() {
      if (!notesPath) {
        // 首次启动，获取默认路径
        const info = await window.api.getAppInfo()
        const defaultPath = info.notesPath
        updateNotesPath(defaultPath)
        return
      }
    }

    initialize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesPath])

  // 应用初始排序
  useEffect(() => {
    async function applyInitialSort() {
      if (notesTree.length > 0 && !isInitialSortApplied.current) {
        try {
          await sortAllLevels(sortType)
          isInitialSortApplied.current = true
        } catch (error) {
          logger.error('Failed to apply initial sorting:', error as Error)
        }
      }
    }

    applyInitialSort()
  }, [notesTree.length, sortType])

  // Handle state management during tree synchronization
  useEffect(() => {
    if (notesTree.length === 0) return
    // Clear activeFilePath if corresponding node is not found
    // But exclude cases where tree sync or pending operations are in progress to avoid incorrect clearing
    const shouldClearPath =
      activeFilePath && !activeNode && !isSyncingTreeRef.current && !operationManager.hasPendingOperations()

    if (shouldClearPath) {
      logger.warn('Clearing activeFilePath - node not found in tree', {
        activeFilePath,
        reason: 'Node not found in current tree'
      })
      dispatch(setActiveFilePath(undefined))
    }
  }, [notesTree, activeFilePath, activeNode, dispatch, operationManager])

  useEffect(() => {
    if (!notesPath || notesTree.length === 0) return

    async function startFileWatcher() {
      // 清理之前的监控
      if (watcherRef.current) {
        watcherRef.current()
        watcherRef.current = null
      }

      // Define file change handler function
      const handleFileChange = async (data: FileChangeEvent) => {
        try {
          if (!notesPath) return
          const { eventType, filePath } = data

          // Skip file system events that could conflict with pending operations
          // Only block structural changes (add/delete/rename), allow content changes
          const isStructuralEvent = ['add', 'addDir', 'unlink', 'unlinkDir'].includes(eventType)
          if (isStructuralEvent && operationManager.hasPendingOperations()) {
            logger.debug('Skipping structural file event during pending operations:', {
              eventType,
              filePath,
              pendingCount: pendingOperationsRef.current.size,
              operations: Array.from(pendingOperationsRef.current)
            })
            return
          }

          switch (eventType) {
            case 'change': {
              // Handle file content changes - only trigger updates when content actually changes
              if (activeFilePath === filePath) {
                try {
                  // Read latest file content
                  // const newFileContent = await window.api.file.readExternal(filePath)
                  // // Get current editor/cached content
                  // const currentEditorContent = editorRef.current?.getMarkdown()
                  // // Ignore FileWatcher events if editor is not initialized
                  // if (!isEditorInitialized.current) {
                  //   return
                  // }
                  // // Compare if content actually changed
                  // if (newFileContent.trim() !== currentEditorContent?.trim()) {
                  //   invalidateFileContent(filePath)
                  // }
                } catch (error) {
                  logger.error('Failed to read file for content comparison:', error as Error)
                  // On read failure, fall back to original logic
                  invalidateFileContent(filePath)
                }
              } else {
                await initWorkSpace(notesPath, sortType)
              }
              break
            }

            case 'add':
            case 'addDir':
            case 'unlink':
            case 'unlinkDir': {
              // Clear selection if the deleted file is the currently active file
              if ((eventType === 'unlink' || eventType === 'unlinkDir') && activeFilePath === filePath) {
                dispatch(setActiveFilePath(undefined))
              }

              // 设置同步标志，避免竞态条件
              isSyncingTreeRef.current = true

              // 重新同步数据库，useLiveQuery会自动响应数据库变化
              try {
                await initWorkSpace(notesPath, sortType)
              } catch (error) {
                logger.error('Failed to sync database:', error as Error)
              } finally {
                isSyncingTreeRef.current = false
              }
              break
            }

            default:
              logger.debug('Unhandled file event type:', { eventType })
          }
        } catch (error) {
          logger.error('Failed to handle file change:', error as Error)
        }
      }

      try {
        await window.api.file.startFileWatcher(notesPath)
        watcherRef.current = window.api.file.onFileChange(handleFileChange)
      } catch (error) {
        logger.error('Failed to start file watcher:', error as Error)
      }
    }

    startFileWatcher()

    return () => {
      if (watcherRef.current) {
        watcherRef.current()
        watcherRef.current = null
      }
      window.api.file.stopFileWatcher().catch((error) => {
        logger.error('Failed to stop file watcher:', error)
      })

      // 如果有未保存的内容，立即保存
      if (lastContentRef.current && lastContentRef.current !== currentContent && lastFilePathRef.current) {
        saveCurrentNote(lastContentRef.current, lastFilePathRef.current).catch((error) => {
          logger.error('Emergency save failed:', error as Error)
        })
      }

      // 清理防抖函数
      debouncedSave.cancel()
    }
  }, [
    notesPath,
    notesTree.length,
    activeFilePath,
    invalidateFileContent,
    dispatch,
    currentContent,
    debouncedSave,
    saveCurrentNote,
    sortType,
    operationManager
  ])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !currentContent) return
    // 获取编辑器当前内容
    const editorMarkdown = editor.getMarkdown()

    // 只有当编辑器内容与期望内容不一致时才更新
    // 这样既能处理初始化，也能处理后续的内容同步，还能避免光标跳动
    if (editorMarkdown !== currentContent) {
      editor.setMarkdown(currentContent)
    }
  }, [currentContent, activeFilePath])

  // 切换文件时的清理工作
  useEffect(() => {
    return () => {
      // 保存之前文件的内容
      if (lastContentRef.current && lastFilePathRef.current) {
        saveCurrentNote(lastContentRef.current, lastFilePathRef.current).catch((error) => {
          logger.error('Emergency save before file switch failed:', error as Error)
        })
      }

      // 取消防抖保存并清理状态
      debouncedSave.cancel()
      lastContentRef.current = ''
      lastFilePathRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilePath])

  // 获取目标文件夹路径（选中文件夹或根目录）
  const getTargetFolderPath = useCallback(() => {
    if (selectedFolderId) {
      const selectedNode = findNodeById(notesTree, selectedFolderId)
      if (selectedNode && selectedNode.type === 'folder') {
        return selectedNode.externalPath
      }
    }
    return notesPath // 默认返回根目录
  }, [selectedFolderId, notesTree, notesPath, findNodeById])

  // 创建文件夹
  const handleCreateFolder = useCallback(
    async (name: string) => {
      try {
        const targetPath = getTargetFolderPath()
        if (!targetPath) {
          throw new Error('No folder path selected')
        }

        await operationManager.withOperation(`createFolder:${name}`, async () => {
          await createFolder(name, targetPath)
          await sortAllLevels(sortType)
        })
      } catch (error) {
        logger.error('Failed to create folder:', error as Error)
      }
    },
    [getTargetFolderPath, sortType, operationManager]
  )

  // 创建笔记
  const handleCreateNote = useCallback(
    async (name: string) => {
      try {
        const targetPath = getTargetFolderPath()
        if (!targetPath) {
          throw new Error('No folder path selected')
        }

        const newNote = await operationManager.withOperation(`createNote:${name}`, async () => {
          const note = await createNote(name, '', targetPath)
          await sortAllLevels(sortType)
          return note
        })

        dispatch(setActiveFilePath(newNote.externalPath))
        setSelectedFolderId(null)
      } catch (error) {
        logger.error('Failed to create note:', error as Error)
      }
    },
    [dispatch, getTargetFolderPath, sortType, operationManager]
  )

  // 切换展开状态
  const toggleNodeExpanded = useCallback(
    async (nodeId: string) => {
      try {
        const tree = await getNotesTree()
        const node = findNodeById(tree, nodeId)

        if (node && node.type === 'folder') {
          await updateNodeInTree(tree, nodeId, {
            expanded: !node.expanded
          })
        }

        return tree
      } catch (error) {
        logger.error('Failed to toggle expanded:', error as Error)
        throw error
      }
    },
    [findNodeById]
  )

  const handleToggleExpanded = useCallback(
    async (nodeId: string) => {
      try {
        await toggleNodeExpanded(nodeId)
      } catch (error) {
        logger.error('Failed to toggle expanded:', error as Error)
      }
    },
    [toggleNodeExpanded]
  )

  // 切换收藏状态
  const toggleStarred = useCallback(
    async (nodeId: string) => {
      try {
        const tree = await getNotesTree()
        const node = findNodeById(tree, nodeId)

        if (node && node.type === 'file') {
          await updateNodeInTree(tree, nodeId, {
            isStarred: !node.isStarred
          })
        }

        return tree
      } catch (error) {
        logger.error('Failed to toggle star:', error as Error)
        throw error
      }
    },
    [findNodeById]
  )

  const handleToggleStar = useCallback(
    async (nodeId: string) => {
      try {
        await toggleStarred(nodeId)
      } catch (error) {
        logger.error('Failed to toggle star:', error as Error)
      }
    },
    [toggleStarred]
  )

  // 选择节点
  const handleSelectNode = useCallback(
    async (node: NotesTreeNode) => {
      if (node.type === 'file') {
        try {
          dispatch(setActiveFilePath(node.externalPath))
          invalidateFileContent(node.externalPath)
          // 清除文件夹选择状态
          setSelectedFolderId(null)
        } catch (error) {
          logger.error('Failed to load note:', error as Error)
        }
      } else if (node.type === 'folder') {
        setSelectedFolderId(node.id)
        await handleToggleExpanded(node.id)
      }
    },
    [dispatch, handleToggleExpanded, invalidateFileContent]
  )

  // 删除节点
  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      try {
        const nodeToDelete = findNodeById(notesTree, nodeId)
        if (!nodeToDelete) return

        const isActiveNodeOrParent =
          activeFilePath &&
          (nodeToDelete.externalPath === activeFilePath || isParentNode(notesTree, nodeId, activeNode?.id || ''))

        await deleteNode(nodeId)
        await sortAllLevels(sortType)

        // 如果删除的是当前活动节点或其父节点，清空编辑器
        if (isActiveNodeOrParent) {
          dispatch(setActiveFilePath(undefined))
          if (editorRef.current) {
            editorRef.current.clear()
          }
        }
      } catch (error) {
        logger.error('Failed to delete node:', error as Error)
      }
    },
    [findNodeById, notesTree, activeFilePath, activeNode?.id, sortType, dispatch]
  )

  // 重命名节点
  const handleRenameNode = useCallback(
    async (nodeId: string, newName: string) => {
      try {
        const tree = await getNotesTree()
        const node = findNodeById(tree, nodeId)

        if (node && node.name !== newName) {
          const oldExternalPath = node.externalPath

          const renamedNode = await operationManager.withOperation(`renameNode:${nodeId}:${newName}`, async () => {
            const renamed = await renameNode(nodeId, newName)
            await sortAllLevels(sortType)
            return renamed
          })

          // 更新活动文件路径
          if (renamedNode.type === 'file' && activeFilePath === oldExternalPath) {
            dispatch(setActiveFilePath(renamedNode.externalPath))
          } else if (
            renamedNode.type === 'folder' &&
            activeFilePath &&
            activeFilePath.startsWith(oldExternalPath + '/')
          ) {
            const relativePath = activeFilePath.substring(oldExternalPath.length)
            const newFilePath = renamedNode.externalPath + relativePath
            dispatch(setActiveFilePath(newFilePath))
          }

          if (renamedNode.name !== newName) {
            window.toast.info(t('notes.rename_changed', { original: newName, final: renamedNode.name }))
          }
        }
      } catch (error) {
        logger.error('Failed to rename node:', error as Error)
      }
    },
    [activeFilePath, dispatch, findNodeById, sortType, t, operationManager]
  )

  // 处理文件上传
  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      try {
        if (!files || files.length === 0) {
          window.toast.warning(t('notes.no_file_selected'))
          return
        }

        const targetFolderPath = getTargetFolderPath()
        if (!targetFolderPath) {
          throw new Error('No folder path selected')
        }

        const result = await uploadFiles(files, targetFolderPath)

        // 检查上传结果
        if (result.fileCount === 0) {
          window.toast.warning(t('notes.no_valid_files'))
          return
        }

        // 排序并显示成功信息
        await sortAllLevels(sortType)

        const successMessage = t('notes.upload_success')

        window.toast.success(successMessage)
      } catch (error) {
        logger.error('Failed to handle file upload:', error as Error)
        window.toast.error(t('notes.upload_failed'))
      }
    },
    [getTargetFolderPath, sortType, t]
  )

  // 处理节点移动
  const handleMoveNode = useCallback(
    async (sourceNodeId: string, targetNodeId: string, position: 'before' | 'after' | 'inside') => {
      try {
        const result = await moveNode(sourceNodeId, targetNodeId, position)
        if (result.success && result.type !== 'manual_reorder') {
          await sortAllLevels(sortType)
        }
      } catch (error) {
        logger.error('Failed to move nodes:', error as Error)
      }
    },
    [sortType]
  )

  // 处理节点排序
  const handleSortNodes = useCallback(
    async (newSortType: NotesSortType) => {
      try {
        // 更新Redux中的排序类型
        dispatch(setSortType(newSortType))
        await sortAllLevels(newSortType)
      } catch (error) {
        logger.error('Failed to sort notes:', error as Error)
        throw error
      }
    },
    [dispatch]
  )

  const getCurrentNoteContent = useCallback(() => {
    if (settings.defaultEditMode === 'source') {
      return currentContent
    } else {
      return editorRef.current?.getMarkdown() || currentContent
    }
  }, [currentContent, settings.defaultEditMode])

  return (
    <Container id="notes-page">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('notes.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <AnimatePresence initial={false}>
          {showWorkspace && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 250, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{ overflow: 'hidden' }}>
              <NotesSidebar
                notesTree={notesTree}
                selectedFolderId={selectedFolderId}
                onSelectNode={handleSelectNode}
                onCreateFolder={handleCreateFolder}
                onCreateNote={handleCreateNote}
                onDeleteNode={handleDeleteNode}
                onRenameNode={handleRenameNode}
                onToggleExpanded={handleToggleExpanded}
                onToggleStar={handleToggleStar}
                onMoveNode={handleMoveNode}
                onSortNodes={handleSortNodes}
                onUploadFiles={handleUploadFiles}
              />
            </motion.div>
          )}
        </AnimatePresence>
        <EditorWrapper>
          <HeaderNavbar
            notesTree={notesTree}
            getCurrentNoteContent={getCurrentNoteContent}
            onToggleStar={handleToggleStar}
          />
          <NotesEditor
            activeNodeId={activeNode?.id}
            currentContent={currentContent}
            tokenCount={tokenCount}
            isLoading={isContentLoading}
            onMarkdownChange={handleMarkdownChange}
            editorRef={editorRef}
          />
        </EditorWrapper>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 0;
`

const EditorWrapper = styled.div`
  display: flex;
  position: relative;
  flex-direction: column;
  justify-content: space-between;
  width: 100%;
  flex: 1;
  max-width: 100%;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
`

export default NotesPage
