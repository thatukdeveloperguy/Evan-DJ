fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'OMBF & TheEvanGuy'
description 'Jim_DJ doesnt work without QB so Evan built a replacement'
version '0.0.5'

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

dependency 'ox_target'

dependency '/assetpacks'