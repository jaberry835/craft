// Required for Angular
import { Component, OnInit, NgModule, ViewChild, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
// Required for MSAL
import { MsalBroadcastService, MsalService } from '@azure/msal-angular';

// Required for Angular multi-browser support
import { EventMessage, EventType, AuthenticationResult } from '@azure/msal-browser';

// Required for RJXS observables
import { filter } from 'rxjs/operators';
import { AiChatService } from '../aichat.service';
import { FormsModule } from '@angular/forms';
import { MarkdownModule } from 'ngx-markdown';
import { UnicodeDecoderPipe } from '../pipes/unicodeDecoder';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PreviewFileType {
  title: string;        // Title of the file
  filepath: string;     // Filepath or URL to the file
  preview: string;
}

@Component({
  selector: 'app-chat-with-data',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownModule],
  templateUrl: './chat-with-data.component.html',
  styleUrl: './chat-with-data.component.css'
})


export class ChatWithDataComponent {
  messages: ChatMessage[] = [];
  chatCunks: any[] = [];
  userInput: string = '';
  isLoading: boolean = false;
  @ViewChild('chatContainer') chatContainer!: ElementRef;

  pFile: PreviewFileType = { title: '', filepath: '', preview: '' };
  // @ts-ignore

  constructor(
    private authService: MsalService,
    private msalBroadcastService: MsalBroadcastService,
    private aiChatService: AiChatService
    //   private AiChatService: AiChatService
  ) {

  }

  // Subscribe to the msalSubject$ observable on the msalBroadcastService
  // This allows the app to consume emitted events from MSAL
  ngOnInit(): void {
    this.msalBroadcastService.msalSubject$
      .pipe(
        filter((msg: EventMessage) => msg.eventType === EventType.LOGIN_SUCCESS),
      )
      .subscribe((result: EventMessage) => {
        const payload = result.payload as AuthenticationResult;
        this.authService.instance.setActiveAccount(payload.account);
      });

    // Initialize with some default messages.
    this.messages.push({
      role: 'assistant',
      content: 'Hello! I am chat bot that works on your data, ask me questions of your data collection!'
    });

  }

  ngAfterViewChecked() {
    this.scrollToBottom();
  }

  async click() {
    this.messages.push({
      role: 'user',
      content: this.userInput
    });

    this.userInput == '';
    this.isLoading = true;
    await this.aiChatService.getChatResponse(this.messages).then((airesponse) => {
      this.userInput = '';
      this.chatCunks.push(airesponse);
      // @ts-ignore
      let txt = this.buildCitationLink(airesponse.choices[0].message.content, airesponse.id);
      this.messages.push({
        role: 'assistant',
        // @ts-ignore
        content: txt
      });
      this.isLoading = false;
    }).catch((err) => {
      this.isLoading = false;
      console.log(err);

    }).finally(() => {
      this.isLoading = false;
      this.scrollToBottom();
    });

  }

  buildCitationLink(text: string, id: string): string {
    if (!text) {
      return text; // Return original text if null or empty
    }

    let newtxt = text.replace(/\[doc(\d+)\]/g, (match, docId) => {
      // Replace [docX] with a clickable link
      return `<a href="#/chat/${docId}/${id}">[${docId}]</a>`;
    });

    return newtxt;
  }

  onEnter(): void {

    this.click();
  }

  // Scroll to the bottom of the chat container
  private scrollToBottom(): void {
    if (this.chatContainer) {
      this.chatContainer.nativeElement.scroll({
        top: this.chatContainer.nativeElement.scrollHeight,
        behavior: 'smooth' // Enables smooth scrolling
      });
    }
  }

  @HostListener('document:click', ['$event'])
  handleClick(event: Event): void {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const href = target.getAttribute('href');
    if (href) {
      // Extract parameters from the URL fragment
      const fragment = href.split('#/chat')[1]; // Remove the '#'
      const parts = fragment.split('/');
      const docidRef = parts[1]; // Example: '1'
      const messageidRef = parts[2]; // Example: 'b628eeaa-818c-434f-a553-9621e01cd022'

      this.showCitation(docidRef, messageidRef); // Call the function with the extracted parameters
    }

  }

  showCitation(docId: string, messageId: string): void {
    console.log('Citation clicked:', docId, messageId);
    if (this.chatCunks.length > 0) {
      let item = this.chatCunks.find(x => x.id == messageId).choices[0].message.context.citations[this.subtractOne(docId)];
      let txt = item.content;
      this.pFile.preview = item.content;
      this.pFile.filepath = item.filepath;
      this.pFile.title = item.title;

    }
    // Handle the citation click event here
  }

  subtractOne(input: string | number): string {
    return (Number(input) - 1).toString();

  } // Funct
  // 
  //   // Function for Reset Button
  reset() {
    this.userInput = ''; // Clear the textarea
    console.log('Input has been reset');
    this.messages = [];
    this.pFile = { title: '', filepath: '', preview: '' };
  }

  // Function for Settings Button
  openSettings() {
    // Logic to open settings (e.g., navigate to settings page or display a modal)
    console.log('Settings button clicked');
  }

  removeLinks(content: string): string {
    // Regular expression to match <a> tags and their contents
    return content.replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1'); // Retain only the text inside the <a> tag
  }

  exportChat() {
    console.log('Export button clicked');

    // Format the conversation as a string for the export file
    const chatContent = this.messages
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`) // Format each message
      .join('\n'); // Combine all messages into one string with line breaks

    // Generate the current date and time
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-'); // Format as ISO string and replace invalid filename characters

    // Create the filename with date and time
    const filename = `chat_with_data_${timestamp}.txt`;

    // Create a Blob object to hold the text file
    const sancontent = this.removeLinks(chatContent);
    const blob = new Blob([sancontent], { type: 'text/plain' });

    // Generate a URL for the Blob
    const url = window.URL.createObjectURL(blob);

    // Create a temporary <a> element to trigger the download
    const link = document.createElement('a');
    link.href = url;
    link.download = filename; // Dynamic filename with timestamp
    link.click(); // Trigger the download

    // Clean up the URL after download is triggered
    window.URL.revokeObjectURL(url);

    console.log('Chat exported successfully as', filename);
  }



}
