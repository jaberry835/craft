import React, { useCallback, useState } from 'react'
import { Box, Typography, Paper, Button } from '@mui/material'
import { CloudUpload, Image } from '@mui/icons-material'

interface FileDropAreaProps {
  onFileSelect: (file: File) => void
}

const FileDropArea: React.FC<FileDropAreaProps> = ({ onFileSelect }) => {
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    
    const files = Array.from(e.dataTransfer.files)
    const imageFile = files.find(file => file.type.startsWith('image/'))
    
    if (imageFile) {
      onFileSelect(imageFile)
    }
  }, [onFileSelect])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && file.type.startsWith('image/')) {
      onFileSelect(file)
    }
  }, [onFileSelect])

  return (
    <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Paper
        sx={{
          width: '100%',
          height: '60%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          border: 2,
          borderStyle: 'dashed',
          borderColor: isDragOver ? 'primary.main' : 'grey.300',
          backgroundColor: isDragOver ? 'primary.light' : 'grey.50',
          cursor: 'pointer',
          transition: 'all 0.3s ease',
          '&:hover': {
            borderColor: 'primary.main',
            backgroundColor: 'primary.light',
          }
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        component="label"
      >
        <input
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileInput}
          aria-label="Upload document image"
        />
        
        <Image sx={{ fontSize: 80, color: 'grey.400', mb: 2 }} />
        
        <Typography variant="h6" gutterBottom color="text.secondary">
          Drop your document image here
        </Typography>
        
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          or click to browse files
        </Typography>
        
        <Button
          variant="outlined"
          startIcon={<CloudUpload />}
          component="span"
        >
          Choose File
        </Button>
        
        <Typography variant="caption" color="text.secondary" sx={{ mt: 2 }}>
          Supported formats: PNG, JPG, JPEG, GIF
        </Typography>
      </Paper>
    </Box>
  )
}

export default FileDropArea
