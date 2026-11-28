import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Bold, Italic, Link as LinkIcon, List, ListOrdered } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TiptapEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
}

const TiptapEditor: React.FC<TiptapEditorProps> = ({
  value = '',
  onChange,
  onFocus,
  onBlur,
  placeholder = 'Start typing...',
  className,
  readOnly = false,
  autoFocus = false,
}) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false, // Disable the default link extension from StarterKit
      }),
      Link.configure({
        // A plan's links go to what it rests on: a click or tap opens them in a new tab
        openOnClick: true,
        HTMLAttributes: {
          class: 'text-primary underline',
        },
      }),
    ],
    content: value,
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      onChange?.(html);
    },
    onFocus: () => {
      onFocus?.();
    },
    onBlur: () => {
      onBlur?.();
    },
  });

  // Update content when value prop changes
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || '');
    }
  }, [editor, value]);

  // Auto-focus when autoFocus prop is true
  useEffect(() => {
    if (autoFocus && editor) {
      // Small delay to ensure the editor is fully rendered
      const timer = setTimeout(() => {
        editor.commands.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocus, editor]);

  if (!editor) {
    return null;
  }

  const addLink = () => {
    const url = window.prompt('Enter URL');
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  };

  const toggleOrderedList = () => {
    editor.chain().focus().toggleOrderedList().run();
  };

  const toggleBulletList = () => {
    editor.chain().focus().toggleBulletList().run();
  };

  return (
    <div className={cn('border rounded-md', className)}>
      {!readOnly && (
        <div className="border-b p-2 flex gap-1 flex-wrap">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={cn('h-8 w-8 p-0', {
              'bg-muted': editor.isActive('bold'),
            })}
          >
            <Bold className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={cn('h-8 w-8 p-0', {
              'bg-muted': editor.isActive('italic'),
            })}
          >
            <Italic className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addLink}
            className={cn('h-8 w-8 p-0', {
              'bg-muted': editor.isActive('link'),
            })}
          >
            <LinkIcon className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleBulletList}
            className={cn('h-8 w-8 p-0', {
              'bg-muted': editor.isActive('bulletList'),
            })}
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleOrderedList}
            className={cn('h-8 w-8 p-0', {
              'bg-muted': editor.isActive('orderedList'),
            })}
          >
            <ListOrdered className="h-4 w-4" />
          </Button>
        </div>
      )}
      <EditorContent
        editor={editor}
        className={cn(
          'prose prose-sm max-w-none p-3 min-h-[120px] focus-within:outline-none text-foreground',
          '[&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[100px] [&_.ProseMirror]:text-foreground',
          '[&_.ProseMirror_p]:text-foreground [&_.ProseMirror_ul]:text-foreground [&_.ProseMirror_ol]:text-foreground',
          '[&_.ProseMirror_li]:text-foreground [&_.ProseMirror_strong]:text-foreground [&_.ProseMirror_em]:text-foreground',
          readOnly && 'cursor-default'
        )}
        placeholder={placeholder}
      />
    </div>
  );
};

export default TiptapEditor;