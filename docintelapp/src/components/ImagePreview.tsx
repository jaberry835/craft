import React, { useState, useEffect, useRef } from 'react'
import { Box, Typography } from '@mui/material'

interface ImagePreviewProps {
  imageUrl: string
  highlights: Array<{
    text: string
    boundingBox: number[]
  }>
}

const ImagePreview: React.FC<ImagePreviewProps> = ({ imageUrl, highlights = [] }) => {
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 })
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      setImageSize({ width: img.width, height: img.height })
    }
    img.src = imageUrl
  }, [imageUrl])

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setContainerSize({ 
          width: rect.width, 
          height: rect.height 
        })
      }
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    
    // Use ResizeObserver for better container size tracking
    const resizeObserver = new ResizeObserver(handleResize)
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    if (imageSize.width && imageSize.height && containerSize.width && containerSize.height) {
      const scaleX = containerSize.width / imageSize.width
      const scaleY = containerSize.height / imageSize.height
      const scale = Math.min(scaleX, scaleY)
      
      setDisplaySize({
        width: imageSize.width * scale,
        height: imageSize.height * scale
      })
    }
  }, [imageSize, containerSize])

  const getScaledBoundingBox = (boundingBox: number[]) => {
    // Check if boundingBox is valid
    if (!boundingBox || !Array.isArray(boundingBox) || boundingBox.length < 4) {
      return null
    }

    // Check if all boundingBox values are numbers
    if (!boundingBox.every(val => typeof val === 'number' && !isNaN(val))) {
      return null
    }

    if (!imageSize.width || !imageSize.height || !displaySize.width || !displaySize.height) {
      return null
    }

    const scaleX = displaySize.width / imageSize.width
    const scaleY = displaySize.height / imageSize.height

    const offsetX = (containerSize.width - displaySize.width) / 2
    const offsetY = (containerSize.height - displaySize.height) / 2

    return {
      left: offsetX + boundingBox[0] * scaleX,
      top: offsetY + boundingBox[1] * scaleY,
      width: (boundingBox[2] - boundingBox[0]) * scaleX,
      height: (boundingBox[3] - boundingBox[1]) * scaleY
    }
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box
        ref={containerRef}
        sx={{
          position: 'relative',
          width: '100%',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          backgroundColor: 'grey.50'
        }}
      >
        <img
          src={imageUrl}
          alt="Document preview"
          className="image-container img"
        />
        
        {Array.isArray(highlights) && highlights.map((highlight, index) => {
          // Skip if highlight is invalid
          if (!highlight || !highlight.boundingBox) {
            return null
          }

          const scaledBox = getScaledBoundingBox(highlight.boundingBox)
          
          if (!scaledBox) return null
          
          return (
            <Box
              key={index}
              sx={{
                position: 'absolute',
                left: scaledBox.left,
                top: scaledBox.top,
                width: scaledBox.width,
                height: scaledBox.height,
                border: 2,
                borderColor: 'primary.main',
                backgroundColor: 'primary.light',
                opacity: 0.3,
                pointerEvents: 'none',
                transition: 'opacity 0.2s ease',
                '&:hover': {
                  opacity: 0.5
                }
              }}
              title={highlight.text || 'Text region'}
            />
          )
        })}
      </Box>
      
      {Array.isArray(highlights) && highlights.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, textAlign: 'center', flexShrink: 0 }}>
          {highlights.length} text regions detected
        </Typography>
      )}
    </Box>
  )
}

export default ImagePreview
