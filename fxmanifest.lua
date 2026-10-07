fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'OMBF & TheEvanGuy'
description 'Music player'
version '1.1.1'

ui_page 'html/index.html'

files {
    'html/index.html',
    'html/app.js',
    'html/style.css'
}

shared_scripts {
    'config.lua'
}

client_scripts {
    'client.lua'
}

server_scripts {
    'server.lua'
}

escrow_ignore {
    'config.lua'
}

dependency 'ox_target'

dependency '/assetpacks'